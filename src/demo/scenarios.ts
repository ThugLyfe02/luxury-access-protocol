/**
 * Demo scenario harness for luxury-access-protocol.
 *
 * Exercises representative paths through the reconstructed system:
 * - Lawful success paths
 * - Hard-stop failures at every major gate
 * - Review/freeze/insurance blocking
 *
 * Run: npx tsx src/demo/scenarios.ts
 *
 * Each scenario uses lawful entity construction (no bypasses)
 * and reports the outcome in a structured format.
 */

import { DomainError } from '../domain/errors/DomainError';
import { InitiateRentalService } from '../application/services/InitiateRentalService';
import { MarketplacePaymentService } from '../application/services/MarketplacePaymentService';
import { ManualReviewEngine } from '../application/services/ManualReviewEngine';
import { AdminRentalInspectionService } from '../application/services/AdminRentalInspectionService';
import { AdminClaimService } from '../application/services/AdminClaimService';
import { AdminAuditQueryService } from '../application/services/AdminAuditQueryService';
import { AuditLog } from '../application/audit/AuditLog';
import { InMemoryAuditSink } from '../infrastructure/audit/InMemoryAuditSink';
import { InMemoryRentalRepository } from '../infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryReviewRepository } from '../infrastructure/repositories/InMemoryReviewRepository';
import { InMemoryClaimRepository } from '../infrastructure/repositories/InMemoryClaimRepository';
import { InMemoryInsuranceRepository } from '../infrastructure/repositories/InMemoryInsuranceRepository';
import { UserActor, SystemActor } from '../application/auth/Actor';
import { MarketplaceRole } from '../domain/enums/MarketplaceRole';
import { ReviewSeverity } from '../domain/enums/ReviewSeverity';
import { EscrowStatus } from '../domain/enums/EscrowStatus';
import {
  SEED_DATES,
  DEMO_EXPOSURE_CONFIG,
  EMPTY_EXPOSURE,
  RENTER_TIER_BRONZE,
  createEligibleRenter,
  createHighRiskRenter,
  createWatchOwner,
  createAdmin,
  createVerifiedWatch,
  createHighValueUnverifiedWatch,
  createHighValueVerifiedWatch,
  createVerifiedKyc,
  createPepFlaggedKyc,
  createActiveInsurance,
  createBlockingReviewCase,
  createOpenClaim,
  createMockPaymentProvider,
} from './seedFactory';

// --- Scenario Infrastructure ---

interface ScenarioResult {
  name: string;
  outcome: 'SUCCESS' | 'BLOCKED';
  details: string;
  errorCode?: string;
}

const results: ScenarioResult[] = [];

function record(result: ScenarioResult): void {
  results.push(result);
  const icon = result.outcome === 'SUCCESS' ? '[OK]' : '[BLOCKED]';
  const code = result.errorCode ? ` (${result.errorCode})` : '';
  // eslint-disable-next-line no-console
  console.log(`  ${icon} ${result.name}${code}`);
  // eslint-disable-next-line no-console
  console.log(`       ${result.details}`);
}

function makeServices() {
  const auditSink = new InMemoryAuditSink();
  const auditLog = new AuditLog(auditSink);
  const provider = createMockPaymentProvider();
  const rentalRepo = new InMemoryRentalRepository();
  const reviewRepo = new InMemoryReviewRepository();
  const claimRepo = new InMemoryClaimRepository();
  const insuranceRepo = new InMemoryInsuranceRepository();

  const initiateRentalService = new InitiateRentalService(provider, auditLog);
  const paymentService = new MarketplacePaymentService(provider, auditLog);
  const reviewEngine = new ManualReviewEngine(reviewRepo, auditLog);
  const rentalInspection = new AdminRentalInspectionService({
    rentalRepo, reviewRepo, claimRepo,
  });
  const claimService = new AdminClaimService({
    claimRepo, insuranceRepo, auditLog,
  });
  const auditQuery = new AdminAuditQueryService(auditLog);

  return {
    auditLog, auditSink, provider,
    rentalRepo, reviewRepo, claimRepo, insuranceRepo,
    initiateRentalService, paymentService, reviewEngine,
    rentalInspection, claimService, auditQuery,
  };
}

function renterActor(userId: string): UserActor {
  return { kind: 'user', userId, role: MarketplaceRole.RENTER };
}

function adminActor(): UserActor {
  return { kind: 'user', userId: 'admin-001', role: MarketplaceRole.ADMIN };
}

function systemActor(): SystemActor {
  return { kind: 'system', source: 'demo_harness' };
}

function defaultInput() {
  return {
    renter: createEligibleRenter(),
    watch: createVerifiedWatch(),
    rentalPrice: 500,
    city: 'NYC',
    zipCode: '10001',
    renterKyc: createVerifiedKyc('renter-eligible-001') as ReturnType<typeof createVerifiedKyc> | null,
    watchInsurance: null as ReturnType<typeof createActiveInsurance> | null,
    renterTier: RENTER_TIER_BRONZE,
    recentRentalTimestamps: [] as Date[],
    exposureSnapshot: { totalActiveWatchValue: 0, totalInsuranceCoverage: 0, activeRentalCount: 0 as number },
    exposureConfig: { ...DEMO_EXPOSURE_CONFIG },
    renterFreezeCases: [] as ReturnType<typeof createBlockingReviewCase>[],
    watchFreezeCases: [] as ReturnType<typeof createBlockingReviewCase>[],
    watchOpenClaims: [] as ReturnType<typeof createOpenClaim>[],
    now: SEED_DATES.now,
  };
}

// --- Scenarios ---

async function scenarioEligibleRental(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();

  try {
    const result = await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Eligible rental — clean renter, verified watch, NYC',
      outcome: 'SUCCESS',
      details: `Rental ${result.rental.id} created, escrow=${result.rental.escrowStatus}, paymentIntent=${result.rental.externalPaymentIntentId}`,
    });
  } catch (e) {
    record({
      name: 'Eligible rental — clean renter, verified watch, NYC',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedSelfRental(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  // Renter IS the watch owner
  input.renter = createWatchOwner(); // id = 'owner-001', same as watch.ownerId
  input.renterKyc = createVerifiedKyc('owner-001');

  try {
    await initiateRentalService.execute(
      renterActor('owner-001'),
      input,
    );
    record({
      name: 'Self-rental — renter is watch owner',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Self-rental — renter is watch owner',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedCityNotActive(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.city = 'LA';
  input.zipCode = '90210';

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'City not active — LA',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'City not active — LA',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedBadZip(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.zipCode = '90210'; // Not NYC ZIP

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Bad ZIP — NYC city with non-NYC zip 90210',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Bad ZIP — NYC city with non-NYC zip 90210',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedHighRiskUser(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.renter = createHighRiskRenter();
  input.renterKyc = createVerifiedKyc('renter-highrisk-001');

  try {
    await initiateRentalService.execute(
      renterActor('renter-highrisk-001'),
      input,
    );
    record({
      name: 'High-risk renter — trust=15, chargebacks=3',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'High-risk renter — trust=15, chargebacks=3',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedNoKyc(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.renterKyc = null;

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'No KYC — renter has no KYC profile',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'No KYC — renter has no KYC profile',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedHighValueUnverified(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.watch = createHighValueUnverifiedWatch(); // $8000, UNVERIFIED

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Unverified high-value watch — $8K, UNVERIFIED',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Unverified high-value watch — $8K, UNVERIFIED',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedNegativeEconomics(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.rentalPrice = 1; // $1 rental for $1500 watch → economics negative

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Negative economics — $1 rental, $1500 watch',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Negative economics — $1 rental, $1500 watch',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedExposureLimit(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.exposureSnapshot = {
    totalActiveWatchValue: 0,
    totalInsuranceCoverage: 0,
    activeRentalCount: 100, // At max
  };

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Exposure limit — platform at max active rentals',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Exposure limit — platform at max active rentals',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedTierCeiling(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  // BRONZE tier ceiling is $2000, watch value $12000
  input.watch = createHighValueVerifiedWatch();

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Tier ceiling — BRONZE renter, $12K watch',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Tier ceiling — BRONZE renter, $12K watch',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedPepFlag(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();
  input.renterKyc = createPepFlaggedKyc('renter-eligible-001');

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'PEP-flagged KYC — politically exposed person',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'PEP-flagged KYC — politically exposed person',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedRenterFrozen(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();

  const freezeCase = createBlockingReviewCase('rental-prev-001', [
    { entityType: 'User', entityId: 'renter-eligible-001' },
  ]);
  input.renterFreezeCases = [freezeCase];

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Renter frozen — HIGH severity review case on renter',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Renter frozen — HIGH severity review case on renter',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioBlockedOpenClaimOnWatch(): Promise<void> {
  const { initiateRentalService } = makeServices();
  const input = defaultInput();

  const claim = createOpenClaim('watch-verified-001', 'rental-prev-001');
  input.watchOpenClaims = [claim];

  try {
    await initiateRentalService.execute(
      renterActor('renter-eligible-001'),
      input,
    );
    record({
      name: 'Open claim on watch — active insurance claim blocks rental',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Open claim on watch — active insurance claim blocks rental',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioFullLifecycle(): Promise<void> {
  const services = makeServices();
  const {
    initiateRentalService, paymentService, rentalRepo,
    reviewRepo, claimRepo, rentalInspection, auditQuery,
  } = services;

  const input = defaultInput();
  const actor = renterActor('renter-eligible-001');
  const admin = adminActor();
  const system = systemActor();

  try {
    // Step 1: Initiate rental
    const result = await initiateRentalService.execute(actor, input);
    await rentalRepo.save(result.rental);

    // Step 2: Payment authorized (webhook)
    const rental = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentAuthorized(system, rental);
    await rentalRepo.save(rental);

    // Step 3: Payment captured (webhook)
    const rental2 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentCaptured(system, rental2);
    await rentalRepo.save(rental2);

    // Step 4: Confirm return (owner)
    const rental3 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.confirmReturn(
      { kind: 'user', userId: 'owner-001', role: MarketplaceRole.OWNER },
      rental3,
      'owner-001',
    );
    await rentalRepo.save(rental3);

    // Step 5: Inspect rental state before release
    const inspection = await rentalInspection.inspectRental(admin, result.rental.id);

    // Step 6: Release to owner
    const rental4 = (await rentalRepo.findById(result.rental.id))!;
    const releaseResult = await paymentService.releaseToOwner(admin, {
      rental: rental4,
      ownerConnectedAccountId: 'acct_owner_001',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    });
    await rentalRepo.save(rental4);

    // Step 7: Check audit trail
    const auditEntries = auditQuery.getEntityHistory(admin, 'Rental', result.rental.id);

    record({
      name: 'Full lifecycle — initiate → authorize → capture → return → release',
      outcome: 'SUCCESS',
      details: [
        `Rental ${result.rental.id}`,
        `Final escrow: ${rental4.escrowStatus}`,
        `Transfer: ${releaseResult.transferId}`,
        `Release blocked before: ${inspection.releaseBlocked} (${inspection.releaseBlockReasons.length} reasons)`,
        `Audit entries: ${auditEntries.length}`,
      ].join(', '),
    });
  } catch (e) {
    record({
      name: 'Full lifecycle — initiate → authorize → capture → return → release',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioDisputeBlocksRelease(): Promise<void> {
  const services = makeServices();
  const { initiateRentalService, paymentService, rentalRepo } = services;

  const input = defaultInput();
  const actor = renterActor('renter-eligible-001');
  const admin = adminActor();
  const system = systemActor();

  try {
    // Setup: create rental through to CAPTURED + return confirmed
    const result = await initiateRentalService.execute(actor, input);
    await rentalRepo.save(result.rental);

    const r1 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentAuthorized(system, r1);
    await rentalRepo.save(r1);

    const r2 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentCaptured(system, r2);
    await rentalRepo.save(r2);

    const r3 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.confirmReturn(
      { kind: 'user', userId: 'owner-001', role: MarketplaceRole.OWNER },
      r3, 'owner-001',
    );
    await rentalRepo.save(r3);

    // Dispute opens!
    const r3b = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handleDisputeOpened(system, r3b);
    await rentalRepo.save(r3b);

    // Attempt release — should be blocked by dispute (wrong escrow state)
    const r4 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.releaseToOwner(admin, {
      rental: r4,
      ownerConnectedAccountId: 'acct_owner_001',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [],
    });

    record({
      name: 'Dispute blocks release — dispute opened after capture',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Dispute blocks release — dispute opened after capture',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioReviewFreezeBlocksRelease(): Promise<void> {
  const services = makeServices();
  const { initiateRentalService, paymentService, rentalRepo, reviewRepo } = services;

  const input = defaultInput();
  const actor = renterActor('renter-eligible-001');
  const admin = adminActor();
  const system = systemActor();

  try {
    // Setup: create rental through to CAPTURED + return confirmed
    const result = await initiateRentalService.execute(actor, input);
    await rentalRepo.save(result.rental);

    const r1 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentAuthorized(system, r1);
    await rentalRepo.save(r1);

    const r2 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentCaptured(system, r2);
    await rentalRepo.save(r2);

    const r3 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.confirmReturn(
      { kind: 'user', userId: 'owner-001', role: MarketplaceRole.OWNER },
      r3, 'owner-001',
    );
    await rentalRepo.save(r3);

    // Create a blocking review case on the rental
    const reviewCase = createBlockingReviewCase(result.rental.id, [
      { entityType: 'Rental', entityId: result.rental.id },
    ]);
    await reviewRepo.save(reviewCase);

    // Attempt release — should be blocked by review freeze
    const r4 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.releaseToOwner(admin, {
      rental: r4,
      ownerConnectedAccountId: 'acct_owner_001',
      ownerShareAmount: 400,
      blockingReviewCases: [reviewCase],
      openClaims: [],
    });

    record({
      name: 'Review freeze blocks release — HIGH severity case on rental',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Review freeze blocks release — HIGH severity case on rental',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioClaimBlocksRelease(): Promise<void> {
  const services = makeServices();
  const { initiateRentalService, paymentService, rentalRepo } = services;

  const input = defaultInput();
  const actor = renterActor('renter-eligible-001');
  const admin = adminActor();
  const system = systemActor();

  try {
    // Setup: create rental through to CAPTURED + return confirmed
    const result = await initiateRentalService.execute(actor, input);
    await rentalRepo.save(result.rental);

    const r1 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentAuthorized(system, r1);
    await rentalRepo.save(r1);

    const r2 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentCaptured(system, r2);
    await rentalRepo.save(r2);

    const r3 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.confirmReturn(
      { kind: 'user', userId: 'owner-001', role: MarketplaceRole.OWNER },
      r3, 'owner-001',
    );
    await rentalRepo.save(r3);

    // Open insurance claim on the rental
    const claim = createOpenClaim('watch-verified-001', result.rental.id);

    // Attempt release — should be blocked by open claim
    const r4 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.releaseToOwner(admin, {
      rental: r4,
      ownerConnectedAccountId: 'acct_owner_001',
      ownerShareAmount: 400,
      blockingReviewCases: [],
      openClaims: [claim],
    });

    record({
      name: 'Insurance claim blocks release — open claim on rental',
      outcome: 'SUCCESS',
      details: 'ERROR: Should have been blocked!',
    });
  } catch (e) {
    record({
      name: 'Insurance claim blocks release — open claim on rental',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

async function scenarioAdminInspectBlockedRental(): Promise<void> {
  const services = makeServices();
  const {
    initiateRentalService, paymentService,
    rentalRepo, reviewRepo, claimRepo, rentalInspection,
  } = services;

  const input = defaultInput();
  const actor = renterActor('renter-eligible-001');
  const admin = adminActor();
  const system = systemActor();

  try {
    // Create rental through to CAPTURED (no return confirmed)
    const result = await initiateRentalService.execute(actor, input);
    await rentalRepo.save(result.rental);

    const r1 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentAuthorized(system, r1);
    await rentalRepo.save(r1);

    const r2 = (await rentalRepo.findById(result.rental.id))!;
    await paymentService.handlePaymentCaptured(system, r2);
    await rentalRepo.save(r2);

    // Add a blocking review case
    const reviewCase = createBlockingReviewCase(result.rental.id, [
      { entityType: 'Rental', entityId: result.rental.id },
    ]);
    await reviewRepo.save(reviewCase);

    // Add an open claim
    const claim = createOpenClaim('watch-verified-001', result.rental.id);
    await claimRepo.save(claim);

    // Admin inspects
    const inspection = await rentalInspection.inspectRental(admin, result.rental.id);

    record({
      name: 'Admin inspect — rental with multiple block reasons',
      outcome: 'SUCCESS',
      details: [
        `Escrow: ${inspection.escrowStatus}`,
        `Release blocked: ${inspection.releaseBlocked}`,
        `Block reasons: ${inspection.releaseBlockReasons.join(' | ')}`,
        `Unresolved reviews: ${inspection.unresolvedReviewCases.length}`,
        `Open claims (rental): ${inspection.openClaimsOnRental.length}`,
      ].join(', '),
    });
  } catch (e) {
    record({
      name: 'Admin inspect — rental with multiple block reasons',
      outcome: 'BLOCKED',
      details: (e as Error).message,
      errorCode: e instanceof DomainError ? e.code : undefined,
    });
  }
}

// --- Runner ---

async function runAllScenarios(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\n=== LUXURY-ACCESS-PROTOCOL — DEMO SCENARIO HARNESS ===\n');
  // eslint-disable-next-line no-console
  console.log('--- Rental Initiation Gates ---\n');

  await scenarioEligibleRental();
  await scenarioBlockedSelfRental();
  await scenarioBlockedCityNotActive();
  await scenarioBlockedBadZip();
  await scenarioBlockedHighRiskUser();
  await scenarioBlockedNoKyc();
  await scenarioBlockedHighValueUnverified();
  await scenarioBlockedNegativeEconomics();
  await scenarioBlockedExposureLimit();
  await scenarioBlockedTierCeiling();
  await scenarioBlockedPepFlag();
  await scenarioBlockedRenterFrozen();
  await scenarioBlockedOpenClaimOnWatch();

  // eslint-disable-next-line no-console
  console.log('\n--- Lifecycle and Release Gates ---\n');

  await scenarioFullLifecycle();
  await scenarioDisputeBlocksRelease();
  await scenarioReviewFreezeBlocksRelease();
  await scenarioClaimBlocksRelease();

  // eslint-disable-next-line no-console
  console.log('\n--- Admin Ops ---\n');

  await scenarioAdminInspectBlockedRental();

  // Summary
  const successes = results.filter((r) => r.outcome === 'SUCCESS').length;
  const blocked = results.filter((r) => r.outcome === 'BLOCKED').length;
  // eslint-disable-next-line no-console
  console.log(`\n=== SUMMARY: ${results.length} scenarios (${successes} success, ${blocked} blocked) ===\n`);
}

runAllScenarios().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Scenario harness crashed:', e);
  process.exit(1);
});
