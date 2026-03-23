import { describe, it, expect, vi } from 'vitest';
import { InitiateRentalService } from '../../../src/application/services/InitiateRentalService';
import { DomainError } from '../../../src/domain/errors/DomainError';
import { User } from '../../../src/domain/entities/User';
import { Watch } from '../../../src/domain/entities/Watch';
import { KycProfile } from '../../../src/domain/entities/KycProfile';
import { InsurancePolicy } from '../../../src/domain/entities/InsurancePolicy';
import { MarketplaceRole } from '../../../src/domain/enums/MarketplaceRole';
import { VerificationStatus } from '../../../src/domain/enums/VerificationStatus';
import { RenterTier } from '../../../src/domain/enums/RenterTier';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';
import { PaymentProvider } from '../../../src/domain/interfaces/PaymentProvider';
import { UserActor } from '../../../src/application/auth/Actor';
import { AuditLog } from '../../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../../src/infrastructure/audit/InMemoryAuditSink';

function makeAuditLog(): AuditLog {
  return new AuditLog(new InMemoryAuditSink());
}

const NOW = new Date('2025-06-01T00:00:00Z');
const ONE_YEAR_AGO = new Date('2024-06-01T00:00:00Z');
const ONE_YEAR_LATER = new Date('2026-06-01T00:00:00Z');

function makePaymentProvider(): PaymentProvider {
  return {
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_test' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/test' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test_123', paymentIntentId: 'pi_test_123' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test' }),
  };
}

function makeRenter(): User {
  return User.create({
    id: 'renter-1',
    role: MarketplaceRole.RENTER,
    trustScore: 80,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
}

function makeWatch(): Watch {
  return Watch.create({
    id: 'watch-1',
    ownerId: 'owner-1',
    marketValue: 1500,
    verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: ONE_YEAR_AGO,
  });
}

function makeKyc(): KycProfile {
  const kyc = KycProfile.create({ userId: 'renter-1', providerReference: 'ref-1', createdAt: ONE_YEAR_AGO });
  kyc.submitForVerification();
  kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
  return kyc;
}

function makeActor(): UserActor {
  return { kind: 'user', userId: 'renter-1', role: MarketplaceRole.RENTER };
}

const defaultExposureConfig = {
  capitalReserve: 500_000,
  maxExposureToCapitalRatio: 3.0,
  maxSingleWatchUncoveredExposure: 50_000,
  maxActiveRentals: 100,
};

const emptyExposure = {
  totalActiveWatchValue: 0,
  totalInsuranceCoverage: 0,
  activeRentalCount: 0,
};

function defaultInput() {
  return {
    renter: makeRenter(),
    watch: makeWatch(),
    rentalPrice: 500,
    city: 'NYC',
    zipCode: '10001',
    renterKyc: makeKyc(),
    watchInsurance: null as InsurancePolicy | null,
    renterTier: RenterTier.BRONZE,
    recentRentalTimestamps: [] as Date[],
    exposureSnapshot: emptyExposure,
    exposureConfig: defaultExposureConfig,
    renterFreezeCases: [],
    watchFreezeCases: [],
    watchOpenClaims: [],
    watchActiveRentals: [],
    now: NOW,
  };
}

describe('InitiateRentalService', () => {
  describe('happy path', () => {
    it('creates rental and transitions to AWAITING_EXTERNAL_PAYMENT', async () => {
      const provider = makePaymentProvider();
      const service = new InitiateRentalService(provider, makeAuditLog());
      const result = await service.execute(makeActor(), defaultInput());

      expect(result.rental.escrowStatus).toBe(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);
      expect(result.rental.externalPaymentIntentId).toBe('pi_test_123');
      expect(result.rental.renterId).toBe('renter-1');
      expect(result.rental.watchId).toBe('watch-1');
      expect(result.blocked).toBe(false);
      expect(provider.createCheckoutSession).toHaveBeenCalledOnce();
    });
  });

  describe('auth gates', () => {
    it('blocks non-user actors', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      await expect(
        service.execute({ kind: 'system', source: 'webhook' }, defaultInput()),
      ).rejects.toThrow(DomainError);
    });

    it('blocks actor mismatched with renter', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const wrongActor: UserActor = { kind: 'user', userId: 'wrong-user', role: MarketplaceRole.RENTER };
      await expect(
        service.execute(wrongActor, defaultInput()),
      ).rejects.toThrow(DomainError);
    });

    it('blocks self-rental (renter is watch owner)', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const actor: UserActor = { kind: 'user', userId: 'owner-1', role: MarketplaceRole.RENTER };
      const input = defaultInput();
      input.renter = User.create({
        id: 'owner-1', role: MarketplaceRole.RENTER,
        trustScore: 80, disputesCount: 0, chargebacksCount: 0, createdAt: ONE_YEAR_AGO,
      });
      input.renterKyc = (() => {
        const kyc = KycProfile.create({ userId: 'owner-1', providerReference: 'ref', createdAt: ONE_YEAR_AGO });
        kyc.submitForVerification();
        kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
        return kyc;
      })();
      await expect(service.execute(actor, input)).rejects.toThrow(DomainError);
    });
  });

  describe('compliance gates', () => {
    it('blocks non-NYC city', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const input = defaultInput();
      input.city = 'LA';
      await expect(service.execute(makeActor(), input)).rejects.toThrow(DomainError);
      try { await service.execute(makeActor(), input); } catch (e) {
        expect((e as DomainError).code).toBe('CITY_NOT_ACTIVE');
      }
    });

    it('blocks invalid NYC ZIP', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const input = defaultInput();
      input.zipCode = '90210';
      await expect(service.execute(makeActor(), input)).rejects.toThrow(DomainError);
    });
  });

  describe('KYC gate', () => {
    it('blocks null KYC', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const input = defaultInput();
      input.renterKyc = null;
      await expect(service.execute(makeActor(), input)).rejects.toThrow(DomainError);
      try { await service.execute(makeActor(), input); } catch (e) {
        expect((e as DomainError).code).toBe('KYC_REQUIRED');
      }
    });
  });

  describe('risk policy gates', () => {
    it('blocks high-risk renter', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const input = defaultInput();
      input.renter = User.create({
        id: 'renter-1', role: MarketplaceRole.RENTER,
        trustScore: 10, disputesCount: 0, chargebacksCount: 0, createdAt: ONE_YEAR_AGO,
      });
      await expect(service.execute(makeActor(), input)).rejects.toThrow(DomainError);
    });
  });

  describe('economics gate', () => {
    it('blocks economically unviable rental (too-low price, high-value watch)', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const input = defaultInput();
      // Watch value 1800 (under BRONZE $2000 ceiling) with rental price 1
      // platformGross = 1 * 0.20 = 0.20
      // processing = 1*0.029 + 0.30 = 0.329
      // lossBuffer = 1800*0.002 = 3.60
      // marginFloor = max(75, 0.20*0.15) = 75
      // net = 0.20 - 0.329 - 3.60 = -3.729 < 75 → ECONOMICS_NEGATIVE
      input.watch = Watch.create({
        id: 'watch-1', ownerId: 'owner-1', marketValue: 1800,
        verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER, createdAt: ONE_YEAR_AGO,
      });
      input.rentalPrice = 1;
      await expect(service.execute(makeActor(), input)).rejects.toThrow(DomainError);
      try { await service.execute(makeActor(), input); } catch (e) {
        expect((e as DomainError).code).toBe('ECONOMICS_NEGATIVE');
      }
    });
  });

  describe('exposure gate', () => {
    it('blocks when platform at max active rentals', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const input = defaultInput();
      // Watch value 1500 (under BRONZE $2000 ceiling) so tier gate passes
      input.exposureSnapshot = { totalActiveWatchValue: 0, totalInsuranceCoverage: 0, activeRentalCount: 100 };
      await expect(service.execute(makeActor(), input)).rejects.toThrow(DomainError);
      try { await service.execute(makeActor(), input); } catch (e) {
        expect((e as DomainError).code).toBe('PLATFORM_EXPOSURE_LIMIT');
      }
    });
  });

  describe('critical risk signal gate', () => {
    it('blocks rental when renter KYC has PEP flag (critical signal)', async () => {
      const service = new InitiateRentalService(makePaymentProvider(), makeAuditLog());
      const input = defaultInput();
      const kyc = makeKyc();
      kyc.flagPep();
      input.renterKyc = kyc;
      // PEP flag causes KYC to not be verified → KYC_REQUIRED gate fires first
      await expect(service.execute(makeActor(), input)).rejects.toThrow(DomainError);
    });
  });
});
