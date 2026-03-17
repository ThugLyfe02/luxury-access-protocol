import { describe, it, expect, vi } from 'vitest';
import { MarketplacePaymentService } from '../../../src/application/services/MarketplacePaymentService';
import { DomainError } from '../../../src/domain/errors/DomainError';
import { Rental } from '../../../src/domain/entities/Rental';
import { ManualReviewCase } from '../../../src/domain/entities/ManualReviewCase';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';
import { ReviewSeverity } from '../../../src/domain/enums/ReviewSeverity';
import { PaymentProvider } from '../../../src/domain/interfaces/PaymentProvider';
import { SystemActor, UserActor } from '../../../src/application/auth/Actor';
import { MarketplaceRole } from '../../../src/domain/enums/MarketplaceRole';
import { AuditLog } from '../../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../../src/infrastructure/audit/InMemoryAuditSink';

function makeAuditLog(): AuditLog {
  return new AuditLog(new InMemoryAuditSink());
}

const NOW = new Date('2025-06-01T00:00:00Z');

function makePaymentProvider(): PaymentProvider {
  return {
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_test' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/test' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test', paymentIntentId: 'pi_test' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test_123' }),
  };
}

const systemActor: SystemActor = { kind: 'system', source: 'stripe_webhook' };
const adminActor: UserActor = { kind: 'user', userId: 'admin-1', role: MarketplaceRole.ADMIN };
const renterActor: UserActor = { kind: 'user', userId: 'renter-1', role: MarketplaceRole.RENTER };

function makeRentalAtStatus(status: EscrowStatus): Rental {
  const rental = Rental.create({
    id: 'rental-1', renterId: 'renter-1', watchId: 'watch-1',
    rentalPrice: 500, createdAt: NOW,
  });

  if (status === EscrowStatus.NOT_STARTED) return rental;

  rental.startExternalPayment('pi_test_intent');
  if (status === EscrowStatus.AWAITING_EXTERNAL_PAYMENT) return rental;

  rental.markPaymentAuthorized();
  if (status === EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED) return rental;

  rental.markPaymentCaptured();
  if (status === EscrowStatus.EXTERNAL_PAYMENT_CAPTURED) return rental;

  if (status === EscrowStatus.DISPUTED) {
    rental.markDisputed();
    return rental;
  }

  if (status === EscrowStatus.REFUNDED) {
    rental.markRefunded();
    return rental;
  }

  if (status === EscrowStatus.FUNDS_RELEASED_TO_OWNER) {
    rental.confirmReturn();
    rental.releaseFunds();
    return rental;
  }

  return rental;
}

describe('MarketplacePaymentService', () => {
  describe('handlePaymentAuthorized', () => {
    it('transitions to AUTHORIZED', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);
      await service.handlePaymentAuthorized(systemActor, rental);
      expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
    });

    it('rejects non-system actor', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);
      await expect(service.handlePaymentAuthorized(renterActor, rental)).rejects.toThrow(DomainError);
    });

    it('rejects terminal rental', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.REFUNDED);
      await expect(service.handlePaymentAuthorized(systemActor, rental)).rejects.toThrow(DomainError);
    });
  });

  describe('handlePaymentCaptured', () => {
    it('transitions to CAPTURED (passive acknowledgment, no provider call)', async () => {
      const provider = makePaymentProvider();
      const service = new MarketplacePaymentService(provider, makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
      await service.handlePaymentCaptured(systemActor, rental);
      expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      // Passive handler does NOT call provider — the capture already happened externally
      expect(provider.capturePayment).not.toHaveBeenCalled();
    });
  });

  describe('requestCapture', () => {
    it('calls capturePayment on provider and transitions', async () => {
      const provider = makePaymentProvider();
      const service = new MarketplacePaymentService(provider, makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
      await service.requestCapture(systemActor, rental);
      expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      expect(provider.capturePayment).toHaveBeenCalledWith('pi_test_intent');
    });

    it('blocks when provider fails to capture', async () => {
      const provider = makePaymentProvider();
      (provider.capturePayment as ReturnType<typeof vi.fn>).mockResolvedValue({ captured: false });
      const service = new MarketplacePaymentService(provider, makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
      await expect(service.requestCapture(systemActor, rental)).rejects.toThrow(DomainError);
    });
  });

  describe('handlePaymentRefunded', () => {
    it('transitions to REFUNDED (passive acknowledgment, no provider call)', async () => {
      const provider = makePaymentProvider();
      const service = new MarketplacePaymentService(provider, makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      await service.handlePaymentRefunded(systemActor, rental);
      expect(rental.escrowStatus).toBe(EscrowStatus.REFUNDED);
      expect(rental.isTerminal()).toBe(true);
      expect(provider.refundPayment).not.toHaveBeenCalled();
    });
  });

  describe('requestRefund', () => {
    it('calls refundPayment on provider and transitions to REFUNDED', async () => {
      const provider = makePaymentProvider();
      const service = new MarketplacePaymentService(provider, makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      await service.requestRefund(systemActor, rental);
      expect(rental.escrowStatus).toBe(EscrowStatus.REFUNDED);
      expect(rental.isTerminal()).toBe(true);
      expect(provider.refundPayment).toHaveBeenCalledWith('pi_test_intent');
    });
  });

  describe('releaseToOwner', () => {
    function makeReleasableRental(): Rental {
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.confirmReturn();
      return rental;
    }

    it('happy path: transfers and transitions to RELEASED', async () => {
      const provider = makePaymentProvider();
      const service = new MarketplacePaymentService(provider, makeAuditLog());
      const rental = makeReleasableRental();

      const result = await service.releaseToOwner(adminActor, {
        rental,
        ownerConnectedAccountId: 'acct_owner',
        ownerShareAmount: 400,
        blockingReviewCases: [], openClaims: [],
      });

      expect(result.transferId).toBe('tr_test_123');
      expect(rental.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
      expect(rental.isTerminal()).toBe(true);
      expect(provider.transferToConnectedAccount).toHaveBeenCalledWith({
        amount: 400,
        connectedAccountId: 'acct_owner',
        rentalId: 'rental-1',
      });
    });

    it('blocks non-admin, non-system actor', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeReleasableRental();
      await expect(
        service.releaseToOwner(renterActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
    });

    it('blocks terminal rental', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
    });

    it('blocks when not in CAPTURED state', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
    });

    it('blocks without confirmed return', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      // NOT calling confirmReturn()
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
      try {
        await service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400, blockingReviewCases: [], openClaims: [],
        });
      } catch (e) {
        expect((e as DomainError).code).toBe('RETURN_NOT_CONFIRMED');
      }
    });

    it('blocks while dispute is open', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.confirmReturn();
      rental.markDisputed();
      // Dispute is open → cannot release
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
    });

    it('blocks with unresolved blocking review cases', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeReleasableRental();
      const blockingCase = ManualReviewCase.create({
        id: 'rc-1', rentalId: 'rental-1', severity: ReviewSeverity.HIGH,
        reason: 'suspicious', createdAt: NOW,
      });
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400,
          blockingReviewCases: [blockingCase], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
      try {
        await service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400,
          blockingReviewCases: [blockingCase], openClaims: [],
        });
      } catch (e) {
        expect((e as DomainError).code).toBe('REVIEW_REQUIRED');
      }
    });

    it('allows resolved review cases (non-blocking)', async () => {
      const provider = makePaymentProvider();
      const service = new MarketplacePaymentService(provider, makeAuditLog());
      const rental = makeReleasableRental();
      const resolvedCase = ManualReviewCase.create({
        id: 'rc-1', rentalId: 'rental-1', severity: ReviewSeverity.HIGH,
        reason: 'suspicious', createdAt: NOW,
      });
      resolvedCase.resolve('admin-1', 'cleared', NOW);

      const result = await service.releaseToOwner(adminActor, {
        rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 400,
        blockingReviewCases: [resolvedCase], openClaims: [],
      });
      expect(result.transferId).toBe('tr_test_123');
    });

    it('blocks missing connected account', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeReleasableRental();
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: '', ownerShareAmount: 400, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
    });

    it('blocks zero owner share', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeReleasableRental();
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 0, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
    });

    it('blocks owner share exceeding rental price (ceiling check)', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeReleasableRental();
      await expect(
        service.releaseToOwner(adminActor, {
          rental, ownerConnectedAccountId: 'acct', ownerShareAmount: 999999, blockingReviewCases: [], openClaims: [],
        }),
      ).rejects.toThrow(DomainError);
    });
  });

  describe('confirmReturn', () => {
    it('allows watch owner to confirm', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      const ownerActor: UserActor = { kind: 'user', userId: 'owner-1', role: MarketplaceRole.OWNER };
      await service.confirmReturn(ownerActor, rental, 'owner-1');
      expect(rental.returnConfirmed).toBe(true);
    });

    it('blocks renter from self-confirming return', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      await expect(
        service.confirmReturn(renterActor, rental, 'owner-1'),
      ).rejects.toThrow(DomainError);
    });

    it('blocks confirm on terminal rental', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.REFUNDED);
      await expect(
        service.confirmReturn(adminActor, rental, 'owner-1'),
      ).rejects.toThrow(DomainError);
    });
  });

  describe('restoreDisputedToCaptured', () => {
    it('restores after dispute resolution', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.DISPUTED);
      rental.resolveDispute();
      await service.restoreDisputedToCaptured(systemActor, rental);
      expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    });

    it('blocks when not in DISPUTED state', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      await expect(
        service.restoreDisputedToCaptured(systemActor, rental),
      ).rejects.toThrow(DomainError);
    });

    it('blocks non-admin/non-system actor', async () => {
      const service = new MarketplacePaymentService(makePaymentProvider(), makeAuditLog());
      const rental = makeRentalAtStatus(EscrowStatus.DISPUTED);
      rental.resolveDispute();
      await expect(
        service.restoreDisputedToCaptured(renterActor, rental),
      ).rejects.toThrow(DomainError);
    });
  });
});
