import { describe, it, expect } from 'vitest';
import { Rental } from '../../../src/domain/entities/Rental';
import { DomainError } from '../../../src/domain/errors/DomainError';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeRental(): Rental {
  return Rental.create({
    id: 'rental-1',
    renterId: 'renter-1',
    watchId: 'watch-1',
    rentalPrice: 500,
    createdAt: NOW,
  });
}

function advanceToState(rental: Rental, targetStatus: EscrowStatus): void {
  if (targetStatus === EscrowStatus.NOT_STARTED) return;

  rental.startExternalPayment('pi_test');
  if (targetStatus === EscrowStatus.AWAITING_EXTERNAL_PAYMENT) return;

  rental.markPaymentAuthorized();
  if (targetStatus === EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED) return;

  rental.markPaymentCaptured();
  if (targetStatus === EscrowStatus.EXTERNAL_PAYMENT_CAPTURED) return;

  if (targetStatus === EscrowStatus.DISPUTED) {
    rental.markDisputed();
    return;
  }

  if (targetStatus === EscrowStatus.REFUNDED) {
    rental.markRefunded();
    return;
  }

  if (targetStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER) {
    rental.confirmReturn();
    rental.releaseFunds();
    return;
  }
}

describe('Rental', () => {
  describe('create', () => {
    it('creates with NOT_STARTED status', () => {
      const rental = makeRental();
      expect(rental.escrowStatus).toBe(EscrowStatus.NOT_STARTED);
      expect(rental.externalPaymentIntentId).toBeNull();
      expect(rental.returnConfirmed).toBe(false);
      expect(rental.disputeOpen).toBe(false);
    });

    it('rejects missing ID', () => {
      expect(() =>
        Rental.create({ id: '', renterId: 'r', watchId: 'w', rentalPrice: 100, createdAt: NOW }),
      ).toThrow(DomainError);
    });

    it('rejects zero price', () => {
      expect(() =>
        Rental.create({ id: 'x', renterId: 'r', watchId: 'w', rentalPrice: 0, createdAt: NOW }),
      ).toThrow(DomainError);
    });

    it('rejects NaN price', () => {
      expect(() =>
        Rental.create({ id: 'x', renterId: 'r', watchId: 'w', rentalPrice: NaN, createdAt: NOW }),
      ).toThrow(DomainError);
    });
  });

  describe('escrow FSM transitions', () => {
    it('follows happy path: NOT_STARTED → AWAITING → AUTHORIZED → CAPTURED → RELEASED', () => {
      const rental = makeRental();
      rental.startExternalPayment('pi_test');
      expect(rental.escrowStatus).toBe(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);
      expect(rental.externalPaymentIntentId).toBe('pi_test');

      rental.markPaymentAuthorized();
      expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);

      rental.markPaymentCaptured();
      expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);

      rental.confirmReturn();
      expect(rental.returnConfirmed).toBe(true);

      rental.releaseFunds();
      expect(rental.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
      expect(rental.isTerminal()).toBe(true);
    });

    it('rejects invalid transition from NOT_STARTED to CAPTURED', () => {
      const rental = makeRental();
      expect(() => rental.markPaymentCaptured()).toThrow(DomainError);
      try { rental.markPaymentCaptured(); } catch (e) {
        expect((e as DomainError).code).toBe('INVALID_ESCROW_TRANSITION');
      }
    });

    it('rejects transition from terminal RELEASED state', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.FUNDS_RELEASED_TO_OWNER);
      expect(() => rental.markRefunded()).toThrow(DomainError);
    });

    it('rejects transition from terminal REFUNDED state', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.markRefunded();
      expect(rental.isTerminal()).toBe(true);
      expect(() => rental.markPaymentCaptured()).toThrow(DomainError);
    });
  });

  describe('startExternalPayment', () => {
    it('rejects empty session ID', () => {
      const rental = makeRental();
      expect(() => rental.startExternalPayment('')).toThrow(DomainError);
      try { rental.startExternalPayment(''); } catch (e) {
        expect((e as DomainError).code).toBe('INVALID_PAYMENT_TRANSITION');
      }
    });
  });

  describe('confirmReturn', () => {
    it('succeeds after payment captured', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.confirmReturn();
      expect(rental.returnConfirmed).toBe(true);
    });

    it('rejects double confirmation', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.confirmReturn();
      expect(() => rental.confirmReturn()).toThrow(DomainError);
      try { rental.confirmReturn(); } catch (e) {
        expect((e as DomainError).code).toBe('INVALID_STATE_TRANSITION');
      }
    });

    it('rejects before payment capture', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
      expect(() => rental.confirmReturn()).toThrow(DomainError);
    });
  });

  describe('releaseFunds', () => {
    it('rejects without confirmed return', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      expect(() => rental.releaseFunds()).toThrow(DomainError);
      try { rental.releaseFunds(); } catch (e) {
        expect((e as DomainError).code).toBe('RETURN_NOT_CONFIRMED');
      }
    });

    it('rejects while dispute is open', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.confirmReturn();
      rental.markDisputed();
      expect(() => rental.releaseFunds()).toThrow(DomainError);
      try { rental.releaseFunds(); } catch (e) {
        expect((e as DomainError).code).toBe('DISPUTE_LOCK');
      }
    });
  });

  describe('dispute lifecycle', () => {
    it('opens and resolves dispute', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.markDisputed();
      expect(rental.escrowStatus).toBe(EscrowStatus.DISPUTED);
      expect(rental.disputeOpen).toBe(true);

      rental.resolveDispute();
      expect(rental.disputeOpen).toBe(false);
      expect(rental.escrowStatus).toBe(EscrowStatus.DISPUTED);
    });

    it('restores to captured after dispute resolution', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.markDisputed();
      rental.resolveDispute();
      rental.restoreToCaptured();
      expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    });

    it('blocks restoreToCaptured while dispute still open', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      rental.markDisputed();
      expect(() => rental.restoreToCaptured()).toThrow(DomainError);
      try { rental.restoreToCaptured(); } catch (e) {
        expect((e as DomainError).code).toBe('DISPUTE_LOCK');
      }
    });

    it('blocks resolveDispute when no dispute is open', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      expect(() => rental.resolveDispute()).toThrow(DomainError);
    });
  });

  describe('markRefunded', () => {
    it('allows refund from AWAITING state', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.AWAITING_EXTERNAL_PAYMENT);
      rental.markRefunded();
      expect(rental.escrowStatus).toBe(EscrowStatus.REFUNDED);
    });

    it('blocks refund after funds released', () => {
      const rental = makeRental();
      advanceToState(rental, EscrowStatus.FUNDS_RELEASED_TO_OWNER);
      expect(() => rental.markRefunded()).toThrow(DomainError);
      try { rental.markRefunded(); } catch (e) {
        expect((e as DomainError).code).toBe('INVALID_ESCROW_TRANSITION');
      }
    });
  });

  describe('restore', () => {
    it('rejects unknown escrow status', () => {
      expect(() =>
        Rental.restore({
          id: 'r1', renterId: 'u1', watchId: 'w1', rentalPrice: 100,
          escrowStatus: 'BOGUS', externalPaymentIntentId: null,
          returnConfirmed: false, disputeOpen: false, createdAt: NOW, version: 0,
        }),
      ).toThrow(DomainError);
    });

    it('rejects NOT_STARTED with payment intent', () => {
      expect(() =>
        Rental.restore({
          id: 'r1', renterId: 'u1', watchId: 'w1', rentalPrice: 100,
          escrowStatus: 'NOT_STARTED', externalPaymentIntentId: 'pi_x',
          returnConfirmed: false, disputeOpen: false, createdAt: NOW, version: 0,
        }),
      ).toThrow(DomainError);
    });

    it('rejects returnConfirmed before capture', () => {
      expect(() =>
        Rental.restore({
          id: 'r1', renterId: 'u1', watchId: 'w1', rentalPrice: 100,
          escrowStatus: 'AWAITING_EXTERNAL_PAYMENT', externalPaymentIntentId: 'pi_x',
          returnConfirmed: true, disputeOpen: false, createdAt: NOW, version: 1,
        }),
      ).toThrow(DomainError);
    });

    it('rejects disputeOpen when not in DISPUTED status', () => {
      expect(() =>
        Rental.restore({
          id: 'r1', renterId: 'u1', watchId: 'w1', rentalPrice: 100,
          escrowStatus: 'EXTERNAL_PAYMENT_CAPTURED', externalPaymentIntentId: 'pi_x',
          returnConfirmed: false, disputeOpen: true, createdAt: NOW, version: 2,
        }),
      ).toThrow(DomainError);
    });
  });
});
