/**
 * Deterministic seed data factory for demo scenarios.
 *
 * Every entity is constructed through lawful domain paths (create + FSM transitions).
 * No raw records, no restore() bypasses, no invariant violations.
 *
 * All IDs, dates, and values are deterministic — running the same scenario
 * twice produces identical results.
 */

import { User } from '../domain/entities/User';
import { Watch } from '../domain/entities/Watch';
import { KycProfile } from '../domain/entities/KycProfile';
import { InsurancePolicy } from '../domain/entities/InsurancePolicy';
import { ManualReviewCase, FreezeTarget } from '../domain/entities/ManualReviewCase';
import { InsuranceClaim } from '../domain/entities/InsuranceClaim';
import { MarketplaceRole } from '../domain/enums/MarketplaceRole';
import { VerificationStatus } from '../domain/enums/VerificationStatus';
import { ReviewSeverity } from '../domain/enums/ReviewSeverity';
import { RenterTier } from '../domain/enums/RenterTier';
import { PaymentProvider } from '../domain/interfaces/PaymentProvider';

// --- Deterministic Dates ---

export const SEED_DATES = {
  oneYearAgo: new Date('2025-06-01T00:00:00Z'),
  sixMonthsAgo: new Date('2025-12-01T00:00:00Z'),
  now: new Date('2026-03-17T12:00:00Z'),
  oneYearFromNow: new Date('2027-06-01T00:00:00Z'),
} as const;

// --- Users ---

export function createEligibleRenter(): User {
  return User.create({
    id: 'renter-eligible-001',
    role: MarketplaceRole.RENTER,
    trustScore: 85,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: SEED_DATES.oneYearAgo,
  });
}

export function createHighRiskRenter(): User {
  return User.create({
    id: 'renter-highrisk-001',
    role: MarketplaceRole.RENTER,
    trustScore: 15,
    disputesCount: 4,
    chargebacksCount: 3,
    createdAt: SEED_DATES.sixMonthsAgo,
  });
}

export function createWatchOwner(): User {
  return User.create({
    id: 'owner-001',
    role: MarketplaceRole.OWNER,
    trustScore: 90,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: SEED_DATES.oneYearAgo,
  });
}

export function createAdmin(): User {
  return User.create({
    id: 'admin-001',
    role: MarketplaceRole.ADMIN,
    trustScore: 100,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: SEED_DATES.oneYearAgo,
  });
}

// --- Watches ---

export function createVerifiedWatch(): Watch {
  return Watch.create({
    id: 'watch-verified-001',
    ownerId: 'owner-001',
    marketValue: 1500,
    verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: SEED_DATES.oneYearAgo,
  });
}

export function createHighValueUnverifiedWatch(): Watch {
  return Watch.create({
    id: 'watch-unverified-hv-001',
    ownerId: 'owner-001',
    marketValue: 8000,
    verificationStatus: VerificationStatus.UNVERIFIED,
    createdAt: SEED_DATES.sixMonthsAgo,
  });
}

export function createHighValueVerifiedWatch(): Watch {
  return Watch.create({
    id: 'watch-verified-hv-001',
    ownerId: 'owner-001',
    marketValue: 12000,
    verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: SEED_DATES.oneYearAgo,
  });
}

// --- KYC Profiles ---

export function createVerifiedKyc(userId: string): KycProfile {
  const kyc = KycProfile.create({
    userId,
    providerReference: `kyc-ref-${userId}`,
    createdAt: SEED_DATES.oneYearAgo,
  });
  kyc.submitForVerification();
  kyc.markVerified(SEED_DATES.oneYearAgo, SEED_DATES.oneYearFromNow);
  return kyc;
}

export function createPepFlaggedKyc(userId: string): KycProfile {
  const kyc = createVerifiedKyc(userId);
  kyc.flagPep();
  return kyc;
}

// --- Insurance Policies ---

export function createActiveInsurance(watchId: string): InsurancePolicy {
  return InsurancePolicy.create({
    id: `ins-${watchId}`,
    watchId,
    providerId: 'insurer-001',
    coverageAmount: 15000,
    deductible: 500,
    premiumPerRental: 50,
    effectiveFrom: SEED_DATES.oneYearAgo,
    effectiveTo: SEED_DATES.oneYearFromNow,
    createdAt: SEED_DATES.oneYearAgo,
  });
}

// --- Review Cases ---

export function createBlockingReviewCase(
  rentalId: string,
  freezeTargets: FreezeTarget[],
): ManualReviewCase {
  return ManualReviewCase.create({
    id: `review-blocking-${rentalId}`,
    rentalId,
    severity: ReviewSeverity.HIGH,
    reason: 'Suspicious velocity pattern detected',
    createdAt: SEED_DATES.now,
    freezeTargets,
  });
}

// --- Insurance Claims ---

export function createOpenClaim(watchId: string, rentalId: string): InsuranceClaim {
  return InsuranceClaim.create({
    id: `claim-${rentalId}`,
    policyId: `ins-${watchId}`,
    rentalId,
    watchId,
    claimAmount: 2000,
    reason: 'Damage reported during rental',
    filedAt: SEED_DATES.now,
  });
}

// --- Mock Payment Provider ---

let sessionCounter = 0;

export function createMockPaymentProvider(): PaymentProvider {
  sessionCounter = 0;
  return {
    createCheckoutSession: async (_rentalId: string, _amount: number) => {
      sessionCounter += 1;
      return { sessionId: `cs_demo_${String(sessionCounter).padStart(3, '0')}` };
    },
    authorizePayment: async (_intentId: string) => ({ authorized: true }),
    capturePayment: async (_intentId: string) => ({ captured: true }),
    refundPayment: async (_intentId: string) => ({ refunded: true }),
    transferToConnectedAccount: async (_params) => ({
      transferId: `tr_demo_${String(sessionCounter).padStart(3, '0')}`,
    }),
  };
}

// --- Exposure Defaults ---

export const DEMO_EXPOSURE_CONFIG = {
  capitalReserve: 500_000,
  maxExposureToCapitalRatio: 3.0,
  maxSingleWatchUncoveredExposure: 50_000,
  maxActiveRentals: 100,
} as const;

export const EMPTY_EXPOSURE = {
  totalActiveWatchValue: 0,
  totalInsuranceCoverage: 0,
  activeRentalCount: 0,
} as const;

export const RENTER_TIER_BRONZE = RenterTier.BRONZE;
