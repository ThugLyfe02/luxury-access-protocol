import { describe, it, expect, vi } from 'vitest';
import { InMemoryRentalRepository } from '../../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryClaimRepository } from '../../../src/infrastructure/repositories/InMemoryClaimRepository';
import { InMemoryWatchRepository } from '../../../src/infrastructure/repositories/InMemoryWatchRepository';
import { InMemoryInsuranceRepository } from '../../../src/infrastructure/repositories/InMemoryInsuranceRepository';
import { InMemoryUserRepository } from '../../../src/infrastructure/repositories/InMemoryUserRepository';
import { InMemoryKycRepository } from '../../../src/infrastructure/repositories/InMemoryKycRepository';
import { InMemoryReviewRepository } from '../../../src/infrastructure/repositories/InMemoryReviewRepository';
import { ExposureSnapshotService } from '../../../src/application/services/ExposureSnapshotService';
import { InitiateRentalService } from '../../../src/application/services/InitiateRentalService';
import { MarketplacePaymentService } from '../../../src/application/services/MarketplacePaymentService';
import { Rental } from '../../../src/domain/entities/Rental';
import { User } from '../../../src/domain/entities/User';
import { Watch } from '../../../src/domain/entities/Watch';
import { InsurancePolicy } from '../../../src/domain/entities/InsurancePolicy';
import { InsuranceClaim } from '../../../src/domain/entities/InsuranceClaim';
import { KycProfile } from '../../../src/domain/entities/KycProfile';
import { ManualReviewCase } from '../../../src/domain/entities/ManualReviewCase';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';
import { InsuranceClaimStatus } from '../../../src/domain/enums/InsuranceClaimStatus';
import { InsurancePolicyStatus } from '../../../src/domain/enums/InsurancePolicyStatus';
import { MarketplaceRole } from '../../../src/domain/enums/MarketplaceRole';
import { ReviewSeverity } from '../../../src/domain/enums/ReviewSeverity';
import { DomainError } from '../../../src/domain/errors/DomainError';
import { PaymentProvider } from '../../../src/domain/interfaces/PaymentProvider';
import { SystemActor, UserActor } from '../../../src/application/auth/Actor';
import { AuditLog } from '../../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../../src/infrastructure/audit/InMemoryAuditSink';

/** Assert that a promise rejects with a DomainError having the expected code */
async function expectDomainError(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected DomainError with code ${expectedCode} but promise resolved`);
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(expectedCode);
  }
}

const NOW = new Date('2026-03-17T12:00:00Z');
const ONE_YEAR_AGO = new Date('2025-03-17T12:00:00Z');
const ONE_YEAR_LATER = new Date('2027-03-17T12:00:00Z');

const RENTER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const WATCH_ID = '33333333-3333-3333-3333-333333333333';
const WATCH_ID_2 = '44444444-4444-4444-4444-444444444444';

const systemActor: SystemActor = { kind: 'system', source: 'test' };
const adminActor: UserActor = { kind: 'user', userId: 'admin-1', role: MarketplaceRole.ADMIN };
const renterActor: UserActor = { kind: 'user', userId: RENTER_ID, role: MarketplaceRole.RENTER };

function makePaymentProvider(): PaymentProvider {
  return {
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_test' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://test.com' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test', paymentIntentId: 'pi_test' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test' }),
  };
}

function makeAuditLog(): AuditLog {
  return new AuditLog(new InMemoryAuditSink());
}

function makeRenter(): User {
  return User.create({
    id: RENTER_ID, role: MarketplaceRole.RENTER,
    trustScore: 85, disputesCount: 0, chargebacksCount: 0, createdAt: ONE_YEAR_AGO,
  });
}

function makeOwner(): User {
  return User.create({
    id: OWNER_ID, role: MarketplaceRole.OWNER,
    trustScore: 90, disputesCount: 0, chargebacksCount: 0, createdAt: ONE_YEAR_AGO,
  });
}

function makeWatch(id: string = WATCH_ID): Watch {
  return Watch.create({
    id, ownerId: OWNER_ID, marketValue: 1500,
    verificationStatus: 'VERIFIED_BY_PARTNER', createdAt: ONE_YEAR_AGO,
  });
}

function makeInsurance(watchId: string = WATCH_ID): InsurancePolicy {
  return InsurancePolicy.create({
    id: `ins-${watchId}`, watchId, providerId: 'provider-1',
    coverageAmount: 15000, deductible: 500, premiumPerRental: 50,
    effectiveFrom: ONE_YEAR_AGO, effectiveTo: ONE_YEAR_LATER, createdAt: ONE_YEAR_AGO,
  });
}

function makeKyc(): KycProfile {
  const kyc = KycProfile.create({
    userId: RENTER_ID, providerReference: 'kyc-ref-1', createdAt: ONE_YEAR_AGO,
  });
  kyc.submitForVerification();
  kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
  return kyc;
}

function makeRentalAtCaptured(rentalId: string = 'rental-1', watchId: string = WATCH_ID): Rental {
  const rental = Rental.create({
    id: rentalId, renterId: RENTER_ID, watchId,
    rentalPrice: 500, createdAt: NOW,
  });
  rental.startExternalPayment('pi_test_intent');
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  return rental;
}

// ============================================================================
// A. DOUBLE-RENTAL PREVENTION
// ============================================================================

describe('Double-rental prevention (repository-backed)', () => {
  it('blocks save of second active rental for same watch', async () => {
    const repo = new InMemoryRentalRepository();

    const rental1 = Rental.create({
      id: 'rental-1', renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental1.startExternalPayment('pi_1');
    await repo.save(rental1);

    const rental2 = Rental.create({
      id: 'rental-2', renterId: 'other-renter', watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental2.startExternalPayment('pi_2');

    await expectDomainError(repo.save(rental2), 'WATCH_ALREADY_RESERVED');
  });

  it('allows rental after previous rental reaches terminal state', async () => {
    const repo = new InMemoryRentalRepository();

    const rental1 = makeRentalAtCaptured('rental-1');
    rental1.confirmReturn();
    rental1.releaseFunds();
    await repo.save(rental1);

    // rental1 is now FUNDS_RELEASED_TO_OWNER (terminal)
    const rental2 = Rental.create({
      id: 'rental-2', renterId: 'other-renter', watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental2.startExternalPayment('pi_2');
    await expect(repo.save(rental2)).resolves.not.toThrow();
  });

  it('findActiveByWatchId returns only non-terminal rentals', async () => {
    const repo = new InMemoryRentalRepository();

    // Terminal rental
    const terminal = makeRentalAtCaptured('rental-terminal');
    terminal.confirmReturn();
    terminal.releaseFunds();
    await repo.save(terminal);

    // Active rental on different watch
    const active = Rental.create({
      id: 'rental-active', renterId: RENTER_ID, watchId: WATCH_ID_2,
      rentalPrice: 500, createdAt: NOW,
    });
    active.startExternalPayment('pi_active');
    await repo.save(active);

    const activeForWatch1 = await repo.findActiveByWatchId(WATCH_ID);
    expect(activeForWatch1).toHaveLength(0);

    const activeForWatch2 = await repo.findActiveByWatchId(WATCH_ID_2);
    expect(activeForWatch2).toHaveLength(1);
    expect(activeForWatch2[0].id).toBe('rental-active');
  });

  it('service-level double-rental blocked via watchActiveRentals input', async () => {
    const pp = makePaymentProvider();
    const auditLog = makeAuditLog();
    const service = new InitiateRentalService(pp, auditLog);

    const existingActive = Rental.create({
      id: 'rental-existing', renterId: 'other-renter', watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    existingActive.startExternalPayment('pi_existing');

    await expectDomainError(service.execute(renterActor, {
      renter: makeRenter(),
      watch: makeWatch(),
      rentalPrice: 500,
      city: 'NYC',
      zipCode: '10001',
      renterKyc: makeKyc(),
      watchInsurance: makeInsurance(),
      renterTier: 'STANDARD',
      recentRentalTimestamps: [],
      exposureSnapshot: { totalActiveWatchValue: 0, totalInsuranceCoverage: 0, activeRentalCount: 0 },
      exposureConfig: {
        capitalReserve: 500_000, maxExposureToCapitalRatio: 3.0,
        maxSingleWatchUncoveredExposure: 50_000, maxActiveRentals: 100,
      },
      renterFreezeCases: [],
      watchFreezeCases: [],
      watchOpenClaims: [],
      watchActiveRentals: [existingActive],
      now: NOW,
    }), 'WATCH_ALREADY_RESERVED');
  });
});

// ============================================================================
// B. RELEASE GATE ENFORCEMENT
// ============================================================================

describe('Release gate enforcement (persistence-backed)', () => {
  it('blocks release when return not confirmed', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = makeRentalAtCaptured();
    // No confirmReturn()

    await expectDomainError(service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    }), 'RETURN_NOT_CONFIRMED');
  });

  it('blocks release when dispute is open (DISPUTED state fails escrow gate)', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = makeRentalAtCaptured();
    rental.confirmReturn();
    rental.markDisputed();

    // DISPUTED status fails Gate 2 (escrowStatus !== CAPTURED) before Gate 4 (disputeOpen)
    await expectDomainError(service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    }), 'INVALID_ESCROW_TRANSITION');
  });

  it('blocks release when insurance claim is open', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = makeRentalAtCaptured();
    rental.confirmReturn();

    const openClaim = InsuranceClaim.create({
      id: 'claim-1', policyId: 'policy-1', rentalId: rental.id,
      watchId: WATCH_ID, claimAmount: 1000, reason: 'damage', filedAt: NOW,
    });

    await expectDomainError(service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [openClaim],
    }), 'INSURANCE_POLICY_INVALID');
  });

  it('blocks release when connected account is missing', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = makeRentalAtCaptured();
    rental.confirmReturn();

    await expectDomainError(service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: '',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    }), 'CONNECTED_ACCOUNT_MISSING');
  });

  it('blocks release when already released (idempotency)', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = makeRentalAtCaptured();
    rental.confirmReturn();

    await service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    });

    // Second attempt: rental is now terminal, caught by terminal check
    await expect(service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    })).rejects.toThrow();
  });

  it('blocks release when blocking review case exists', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = makeRentalAtCaptured();
    rental.confirmReturn();

    const reviewCase = ManualReviewCase.create({
      id: 'review-1', rentalId: rental.id, reason: 'suspicious activity',
      severity: ReviewSeverity.HIGH, riskSignalCodes: ['VELOCITY'],
      createdAt: NOW,
      freezeTargets: [{ entityType: 'Rental', entityId: rental.id }],
    });

    await expectDomainError(service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [reviewCase],
      openClaims: [],
    }), 'REVIEW_REQUIRED');
  });

  it('release succeeds when all conditions are met', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = makeRentalAtCaptured();
    rental.confirmReturn();

    const result = await service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    });

    expect(result.transferId).toBe('tr_test');
    expect(rental.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    expect(rental.isTerminal()).toBe(true);
  });

  it('blocks release when escrow status is not CAPTURED', async () => {
    const pp = makePaymentProvider();
    const service = new MarketplacePaymentService(pp, makeAuditLog());
    const rental = Rental.create({
      id: 'rental-1', renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental.startExternalPayment('pi_test');
    rental.markPaymentAuthorized();
    // Not captured yet

    await expectDomainError(service.releaseToOwner(adminActor, {
      rental,
      ownerConnectedAccountId: 'acct_test',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    }), 'INVALID_ESCROW_TRANSITION');
  });
});

// ============================================================================
// C. EXPOSURE SNAPSHOT TRUTH
// ============================================================================

describe('Exposure snapshot truth (repository-backed)', () => {
  it('computes real exposure from active rentals', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const watchRepo = new InMemoryWatchRepository();
    const insuranceRepo = new InMemoryInsuranceRepository();

    const watch1 = makeWatch(WATCH_ID);
    const watch2 = makeWatch(WATCH_ID_2);
    await watchRepo.save(watch1);
    await watchRepo.save(watch2);

    const insurance1 = makeInsurance(WATCH_ID);
    await insuranceRepo.save(insurance1);
    // Watch 2 has no insurance

    // Active rental on watch 1
    const rental1 = Rental.create({
      id: 'rental-1', renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental1.startExternalPayment('pi_1');
    await rentalRepo.save(rental1);

    // Active rental on watch 2
    const rental2 = Rental.create({
      id: 'rental-2', renterId: RENTER_ID, watchId: WATCH_ID_2,
      rentalPrice: 500, createdAt: NOW,
    });
    rental2.startExternalPayment('pi_2');
    await rentalRepo.save(rental2);

    const service = new ExposureSnapshotService({ rentalRepo, watchRepo, insuranceRepo });
    const snapshot = await service.computeSnapshot();

    expect(snapshot.activeRentalCount).toBe(2);
    expect(snapshot.totalActiveWatchValue).toBe(3000); // 1500 + 1500
    expect(snapshot.totalInsuranceCoverage).toBe(insurance1.netCoverage()); // only watch 1 has insurance
  });

  it('excludes terminal rentals from exposure', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const watchRepo = new InMemoryWatchRepository();
    const insuranceRepo = new InMemoryInsuranceRepository();

    await watchRepo.save(makeWatch(WATCH_ID));

    const rental = makeRentalAtCaptured('rental-terminal');
    rental.confirmReturn();
    rental.releaseFunds();
    await rentalRepo.save(rental);

    const service = new ExposureSnapshotService({ rentalRepo, watchRepo, insuranceRepo });
    const snapshot = await service.computeSnapshot();

    expect(snapshot.activeRentalCount).toBe(0);
    expect(snapshot.totalActiveWatchValue).toBe(0);
  });

  it('exposure snapshot reflects non-zero values for enforcement', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const watchRepo = new InMemoryWatchRepository();
    const insuranceRepo = new InMemoryInsuranceRepository();

    await watchRepo.save(makeWatch(WATCH_ID));

    const rental = Rental.create({
      id: 'rental-1', renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental.startExternalPayment('pi_1');
    await rentalRepo.save(rental);

    const service = new ExposureSnapshotService({ rentalRepo, watchRepo, insuranceRepo });
    const snapshot = await service.computeSnapshot();

    // Verify the snapshot is not fake/zero — it reflects real data
    expect(snapshot.activeRentalCount).toBeGreaterThan(0);
    expect(snapshot.totalActiveWatchValue).toBeGreaterThan(0);
  });
});

// ============================================================================
// D. ENUM SAFETY
// ============================================================================

describe('Enum safety for insurance statuses', () => {
  it('InsuranceClaim.isOpen uses enum-backed comparison', () => {
    const claim = InsuranceClaim.create({
      id: 'claim-1', policyId: 'policy-1', rentalId: 'rental-1',
      watchId: WATCH_ID, claimAmount: 1000, reason: 'damage', filedAt: NOW,
    });

    expect(claim.isOpen()).toBe(true);
    expect(claim.status).toBe(InsuranceClaimStatus.FILED);

    claim.beginReview('reviewer-1');
    expect(claim.isOpen()).toBe(true);
    expect(claim.status).toBe(InsuranceClaimStatus.UNDER_REVIEW);

    claim.approve(NOW, 800);
    expect(claim.isOpen()).toBe(true);
    expect(claim.status).toBe(InsuranceClaimStatus.APPROVED);

    claim.markPaidOut(NOW);
    expect(claim.isOpen()).toBe(false);
    expect(claim.isTerminal()).toBe(true);
    expect(claim.status).toBe(InsuranceClaimStatus.PAID_OUT);
  });

  it('InsuranceClaim.deny produces terminal non-open state', () => {
    const claim = InsuranceClaim.create({
      id: 'claim-2', policyId: 'policy-1', rentalId: 'rental-1',
      watchId: WATCH_ID, claimAmount: 1000, reason: 'damage', filedAt: NOW,
    });
    claim.beginReview('reviewer-1');
    claim.deny(NOW, 'insufficient evidence');

    expect(claim.isOpen()).toBe(false);
    expect(claim.isTerminal()).toBe(true);
    expect(claim.status).toBe(InsuranceClaimStatus.DENIED);
  });

  it('InsurancePolicy.isActive uses enum-safe status check', () => {
    const policy = makeInsurance();
    expect(policy.isActive(NOW)).toBe(true);
    expect(policy.status).toBe(InsurancePolicyStatus.ACTIVE);

    policy.markExpired();
    expect(policy.isActive(NOW)).toBe(false);
    expect(policy.status).toBe(InsurancePolicyStatus.EXPIRED);
  });

  it('ClaimRepository.findOpenByRentalId returns only open claims', async () => {
    const repo = new InMemoryClaimRepository();

    const openClaim = InsuranceClaim.create({
      id: 'claim-open', policyId: 'policy-1', rentalId: 'rental-1',
      watchId: WATCH_ID, claimAmount: 1000, reason: 'damage', filedAt: NOW,
    });
    await repo.save(openClaim);

    const closedClaim = InsuranceClaim.create({
      id: 'claim-closed', policyId: 'policy-1', rentalId: 'rental-1',
      watchId: WATCH_ID, claimAmount: 500, reason: 'scratch', filedAt: NOW,
    });
    closedClaim.beginReview('reviewer-1');
    closedClaim.deny(NOW, 'not covered');
    await repo.save(closedClaim);

    const openByRental = await repo.findOpenByRentalId('rental-1');
    expect(openByRental).toHaveLength(1);
    expect(openByRental[0].id).toBe('claim-open');

    // Also verify findOpenByWatchId consistency
    const openByWatch = await repo.findOpenByWatchId(WATCH_ID);
    expect(openByWatch).toHaveLength(1);
    expect(openByWatch[0].id).toBe('claim-open');
  });
});

// ============================================================================
// E. REPOSITORY CONTRACT TRUTH
// ============================================================================

describe('Repository contract correctness', () => {
  it('InMemoryRentalRepository enforces OCC on save', async () => {
    const repo = new InMemoryRentalRepository();

    const rental = Rental.create({
      id: 'rental-1', renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental.startExternalPayment('pi_1');
    await repo.save(rental);

    // Load two copies
    const copy1 = (await repo.findById('rental-1'))!;
    const copy2 = (await repo.findById('rental-1'))!;

    // Mutate and save copy1
    copy1.markPaymentAuthorized();
    await repo.save(copy1);

    // copy2 is now stale — save should fail
    copy2.markPaymentAuthorized();
    await expectDomainError(repo.save(copy2), 'VERSION_CONFLICT');
  });

  it('InMemoryClaimRepository enforces OCC on save', async () => {
    const repo = new InMemoryClaimRepository();

    const claim = InsuranceClaim.create({
      id: 'claim-1', policyId: 'policy-1', rentalId: 'rental-1',
      watchId: WATCH_ID, claimAmount: 1000, reason: 'damage', filedAt: NOW,
    });
    await repo.save(claim);

    const copy1 = (await repo.findById('claim-1'))!;
    const copy2 = (await repo.findById('claim-1'))!;

    copy1.beginReview('reviewer-1');
    await repo.save(copy1);

    copy2.beginReview('reviewer-2');
    await expectDomainError(repo.save(copy2), 'VERSION_CONFLICT');
  });

  it('findActiveByWatchId and findAllActive are consistent', async () => {
    const repo = new InMemoryRentalRepository();

    const rental = Rental.create({
      id: 'rental-1', renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: NOW,
    });
    rental.startExternalPayment('pi_1');
    await repo.save(rental);

    const activeByWatch = await repo.findActiveByWatchId(WATCH_ID);
    const allActive = await repo.findAllActive();

    expect(activeByWatch).toHaveLength(1);
    expect(allActive).toHaveLength(1);
    expect(activeByWatch[0].id).toBe(allActive[0].id);

    // Empty result for unrelated watch
    const noResults = await repo.findActiveByWatchId('nonexistent-watch');
    expect(noResults).toHaveLength(0);
  });
});
