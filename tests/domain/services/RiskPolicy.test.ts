import { describe, it, expect } from 'vitest';
import { RiskPolicy } from '../../../src/domain/services/RiskPolicy';
import { DomainError } from '../../../src/domain/errors/DomainError';
import { User } from '../../../src/domain/entities/User';
import { Watch } from '../../../src/domain/entities/Watch';
import { KycProfile } from '../../../src/domain/entities/KycProfile';
import { InsurancePolicy } from '../../../src/domain/entities/InsurancePolicy';
import { MarketplaceRole } from '../../../src/domain/enums/MarketplaceRole';
import { VerificationStatus } from '../../../src/domain/enums/VerificationStatus';
import { KycStatus } from '../../../src/domain/enums/KycStatus';

const NOW = new Date('2025-06-01T00:00:00Z');
const ONE_YEAR_LATER = new Date('2026-06-01T00:00:00Z');
const ONE_YEAR_AGO = new Date('2024-06-01T00:00:00Z');

function makeUser(overrides: Partial<{ id: string; role: MarketplaceRole; trustScore: number; disputesCount: number; chargebacksCount: number }> = {}): User {
  return User.create({
    id: overrides.id ?? 'renter-1',
    role: overrides.role ?? MarketplaceRole.RENTER,
    trustScore: overrides.trustScore ?? 80,
    disputesCount: overrides.disputesCount ?? 0,
    chargebacksCount: overrides.chargebacksCount ?? 0,
    createdAt: ONE_YEAR_AGO,
  });
}

function makeWatch(overrides: Partial<{ id: string; ownerId: string; marketValue: number; verificationStatus: VerificationStatus }> = {}): Watch {
  return Watch.create({
    id: overrides.id ?? 'watch-1',
    ownerId: overrides.ownerId ?? 'owner-1',
    marketValue: overrides.marketValue ?? 3000,
    verificationStatus: overrides.verificationStatus ?? VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: ONE_YEAR_AGO,
  });
}

function makeVerifiedKyc(userId: string = 'renter-1'): KycProfile {
  const kyc = KycProfile.create({ userId, providerReference: 'ref-1', createdAt: ONE_YEAR_AGO });
  kyc.submitForVerification();
  kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
  return kyc;
}

function makeInsurance(watchId: string = 'watch-1', coverageAmount: number = 10000): InsurancePolicy {
  return InsurancePolicy.create({
    id: 'ins-1',
    watchId,
    providerId: 'provider-1',
    coverageAmount,
    deductible: 500,
    premiumPerRental: 50,
    effectiveFrom: ONE_YEAR_AGO,
    effectiveTo: ONE_YEAR_LATER,
    createdAt: ONE_YEAR_AGO,
  });
}

describe('RiskPolicy', () => {
  describe('ensureCanInitiateRental', () => {
    it('allows valid rental', () => {
      const user = makeUser();
      const watch = makeWatch();
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, 500)).not.toThrow();
    });

    it('blocks self-rental (renter === owner)', () => {
      const user = makeUser({ id: 'owner-1' });
      const watch = makeWatch({ ownerId: 'owner-1' });
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, 500)).toThrow(DomainError);
      try { RiskPolicy.ensureCanInitiateRental(user, watch, 500); } catch (e) {
        expect((e as DomainError).code).toBe('INVALID_RENTAL_PARTIES');
      }
    });

    it('blocks zero or negative rental value', () => {
      const user = makeUser();
      const watch = makeWatch();
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, 0)).toThrow(DomainError);
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, -100)).toThrow(DomainError);
    });

    it('blocks high-risk users', () => {
      const highRiskUser = makeUser({ trustScore: 20 }); // trustScore < 30
      const watch = makeWatch();
      expect(() => RiskPolicy.ensureCanInitiateRental(highRiskUser, watch, 500)).toThrow(DomainError);
      try { RiskPolicy.ensureCanInitiateRental(highRiskUser, watch, 500); } catch (e) {
        expect((e as DomainError).code).toBe('HIGH_RISK_TRANSACTION');
      }
    });

    it('blocks high-risk users with too many chargebacks', () => {
      const user = makeUser({ chargebacksCount: 2 });
      const watch = makeWatch();
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, 500)).toThrow(DomainError);
    });

    it('blocks unverified high-value watches', () => {
      const user = makeUser();
      const watch = makeWatch({ marketValue: 10000, verificationStatus: VerificationStatus.UNVERIFIED });
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, 500)).toThrow(DomainError);
      try { RiskPolicy.ensureCanInitiateRental(user, watch, 500); } catch (e) {
        expect((e as DomainError).code).toBe('WATCH_NOT_VERIFIED');
      }
    });

    it('allows verified high-value watches', () => {
      const user = makeUser();
      const watch = makeWatch({ marketValue: 10000, verificationStatus: VerificationStatus.VERIFIED_IN_VAULT });
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, 500)).not.toThrow();
    });

    it('enforces role rental ceiling for RENTER ($10,000)', () => {
      const user = makeUser({ role: MarketplaceRole.RENTER });
      const watch = makeWatch();
      expect(() => RiskPolicy.ensureCanInitiateRental(user, watch, 10001)).toThrow(DomainError);
      try { RiskPolicy.ensureCanInitiateRental(user, watch, 10001); } catch (e) {
        expect((e as DomainError).code).toBe('TIER_ACCESS_DENIED');
      }
    });

    it('allows ADMIN unlimited rental value', () => {
      const admin = makeUser({ role: MarketplaceRole.ADMIN });
      const watch = makeWatch({ marketValue: 100000, verificationStatus: VerificationStatus.VERIFIED_IN_VAULT });
      expect(() => RiskPolicy.ensureCanInitiateRental(admin, watch, 999999)).not.toThrow();
    });
  });

  describe('ensureKycVerified', () => {
    it('blocks when no KYC profile exists', () => {
      expect(() => RiskPolicy.ensureKycVerified(null, NOW)).toThrow(DomainError);
      try { RiskPolicy.ensureKycVerified(null, NOW); } catch (e) {
        expect((e as DomainError).code).toBe('KYC_REQUIRED');
      }
    });

    it('blocks unverified KYC', () => {
      const kyc = KycProfile.create({ userId: 'u1', providerReference: null, createdAt: NOW });
      expect(() => RiskPolicy.ensureKycVerified(kyc, NOW)).toThrow(DomainError);
    });

    it('allows verified KYC', () => {
      const kyc = makeVerifiedKyc();
      expect(() => RiskPolicy.ensureKycVerified(kyc, NOW)).not.toThrow();
    });

    it('blocks expired KYC', () => {
      const kyc = makeVerifiedKyc();
      const afterExpiry = new Date('2027-01-01T00:00:00Z');
      expect(() => RiskPolicy.ensureKycVerified(kyc, afterExpiry)).toThrow(DomainError);
    });

    it('blocks KYC with PEP flag', () => {
      const kyc = makeVerifiedKyc();
      kyc.flagPep();
      expect(() => RiskPolicy.ensureKycVerified(kyc, NOW)).toThrow(DomainError);
    });

    it('blocks KYC with sanctions flag', () => {
      const kyc = makeVerifiedKyc();
      kyc.flagSanctions();
      expect(() => RiskPolicy.ensureKycVerified(kyc, NOW)).toThrow(DomainError);
    });
  });

  describe('ensureInsuranceActive', () => {
    it('skips insurance check for low-value watches', () => {
      const watch = makeWatch({ marketValue: 4999 });
      expect(() => RiskPolicy.ensureInsuranceActive(null, watch, NOW)).not.toThrow();
    });

    it('blocks high-value watch without insurance', () => {
      const watch = makeWatch({ marketValue: 5000 });
      expect(() => RiskPolicy.ensureInsuranceActive(null, watch, NOW)).toThrow(DomainError);
      try { RiskPolicy.ensureInsuranceActive(null, watch, NOW); } catch (e) {
        expect((e as DomainError).code).toBe('INSURANCE_INACTIVE');
      }
    });

    it('blocks high-value watch with inactive insurance', () => {
      const watch = makeWatch({ marketValue: 6000 });
      const insurance = makeInsurance('watch-1', 10000);
      insurance.markExpired();
      expect(() => RiskPolicy.ensureInsuranceActive(insurance, watch, NOW)).toThrow(DomainError);
    });

    it('blocks high-value watch with insufficient coverage', () => {
      const watch = makeWatch({ marketValue: 20000 });
      const insurance = makeInsurance('watch-1', 10000); // coverage < marketValue
      expect(() => RiskPolicy.ensureInsuranceActive(insurance, watch, NOW)).toThrow(DomainError);
      try { RiskPolicy.ensureInsuranceActive(insurance, watch, NOW); } catch (e) {
        expect((e as DomainError).code).toBe('INSURANCE_POLICY_INVALID');
      }
    });

    it('allows high-value watch with sufficient active insurance', () => {
      const watch = makeWatch({ marketValue: 8000 });
      const insurance = makeInsurance('watch-1', 10000);
      expect(() => RiskPolicy.ensureInsuranceActive(insurance, watch, NOW)).not.toThrow();
    });
  });
});
