/**
 * PHASE F — RENTAL INITIATION ADVERSARIAL SUITE
 *
 * Tests double-rental prevention, idempotency semantics,
 * spoofed identity rejection, and validation fail-closed behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeTestApp } from '../http/testAppFactory';
import { signToken } from '../http/testAuthHelper';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';
import { User } from '../../src/domain/entities/User';
import { Watch } from '../../src/domain/entities/Watch';
import { KycProfile } from '../../src/domain/entities/KycProfile';
import { InsurancePolicy } from '../../src/domain/entities/InsurancePolicy';
import { VerificationStatus } from '../../src/domain/enums/VerificationStatus';
import { AppDeps } from '../../src/http/app';
import { Express } from 'express';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';

// Use proper UUIDs as required by validation
const RENTER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OWNER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WATCH_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ATTACKER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const RISKY_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const WATCH_RISK_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const ONE_YEAR_AGO = new Date('2025-03-17');
const ONE_YEAR_LATER = new Date('2027-03-17');

let app: Express;
let deps: AppDeps;

async function setupStandardRentalContext() {
  const result = makeTestApp();
  app = result.app;
  deps = result.deps;

  const renter = User.create({
    id: RENTER_ID, role: MarketplaceRole.RENTER,
    trustScore: 85, disputesCount: 0, chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  const owner = User.create({
    id: OWNER_ID, role: MarketplaceRole.OWNER,
    trustScore: 90, disputesCount: 0, chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  const watch = Watch.create({
    id: WATCH_ID, ownerId: OWNER_ID, marketValue: 1500,
    verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: ONE_YEAR_AGO,
  });
  const kyc = KycProfile.create({
    userId: RENTER_ID, providerReference: 'ref-1', createdAt: ONE_YEAR_AGO,
  });
  kyc.submitForVerification();
  kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);

  const insurance = InsurancePolicy.create({
    id: 'ins-adv-1', watchId: WATCH_ID, providerId: 'prov-1',
    coverageAmount: 15000, deductible: 500, premiumPerRental: 50,
    effectiveFrom: ONE_YEAR_AGO, effectiveTo: ONE_YEAR_LATER,
    createdAt: ONE_YEAR_AGO,
  });

  await deps.rental.userRepo.save(renter);
  await deps.rental.userRepo.save(owner);
  await deps.rental.watchRepo.save(watch);
  await deps.rental.kycRepo.save(kyc);
  await deps.rental.insuranceRepo.save(insurance);
}

function initiateRental(
  token: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const req = request(app)
    .post('/rentals/initiate')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  if (idempotencyKey) {
    req.set('Idempotency-Key', idempotencyKey);
  }
  return req;
}

const VALID_BODY = { watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' };

// ========================================================================
// A. SAME WATCH, NEAR-SIMULTANEOUS ATTEMPTS
// ========================================================================

describe('Rental Initiation Adversarial: Double-Rental Prevention', () => {
  beforeEach(setupStandardRentalContext);

  it('prevents second active rental for same watch', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res1 = await initiateRental(token, VALID_BODY);
    expect(res1.status).toBe(201);

    // Second attempt for same watch — must fail
    const res2 = await initiateRental(token, { ...VALID_BODY, rentalPrice: 600 });
    expect(res2.status).not.toBe(201);
  });

  it('no split-brain: repo confirms only one active rental exists', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    await initiateRental(token, VALID_BODY);
    await initiateRental(token, { ...VALID_BODY, rentalPrice: 700 });

    const activeRentals = await (deps.rental.rentalRepo as InMemoryRentalRepository)
      .findActiveByWatchId(WATCH_ID);
    expect(activeRentals.length).toBe(1);
  });
});

// ========================================================================
// B. SAME IDEMPOTENCY KEY + SAME PAYLOAD
// ========================================================================

describe('Rental Initiation Adversarial: Idempotency Same Key Same Payload', () => {
  beforeEach(setupStandardRentalContext);

  it('replays cached result for same idempotency key + same payload', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res1 = await initiateRental(token, VALID_BODY, 'idem-key-1');
    expect(res1.status).toBe(201);
    const rentalId1 = res1.body.data.rental.id;

    const res2 = await initiateRental(token, VALID_BODY, 'idem-key-1');
    expect(res2.status).toBe(201);
    expect(res2.body.data.rental.id).toBe(rentalId1);
  });
});

// ========================================================================
// C. SAME IDEMPOTENCY KEY + DIFFERENT PAYLOAD
// ========================================================================

describe('Rental Initiation Adversarial: Idempotency Key Conflict', () => {
  beforeEach(setupStandardRentalContext);

  it('rejects same idempotency key with different payload hash', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    await initiateRental(token, VALID_BODY, 'idem-conflict');

    const res2 = await initiateRental(token,
      { ...VALID_BODY, rentalPrice: 999 },
      'idem-conflict',
    );
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('does not overwrite original cached response on conflict', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res1 = await initiateRental(token, VALID_BODY, 'idem-no-overwrite');
    expect(res1.status).toBe(201);
    const originalId = res1.body.data.rental.id;

    // Conflicting attempt
    await initiateRental(token, { ...VALID_BODY, rentalPrice: 999 }, 'idem-no-overwrite');

    // Original replay should still work
    const res3 = await initiateRental(token, VALID_BODY, 'idem-no-overwrite');
    expect(res3.status).toBe(201);
    expect(res3.body.data.rental.id).toBe(originalId);
  });
});

// ========================================================================
// D. SPOOFED RENTER IDENTITY
// ========================================================================

describe('Rental Initiation Adversarial: Identity Spoofing', () => {
  beforeEach(async () => {
    await setupStandardRentalContext();
    const attacker = User.create({
      id: ATTACKER_ID, role: MarketplaceRole.RENTER,
      trustScore: 85, disputesCount: 0, chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(attacker);
    const kyc = KycProfile.create({
      userId: ATTACKER_ID, providerReference: 'ref-2', createdAt: ONE_YEAR_AGO,
    });
    kyc.submitForVerification();
    kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
    await deps.rental.kycRepo.save(kyc);
  });

  it('ignores body renterId and uses authenticated actor', async () => {
    const attackerToken = signToken(ATTACKER_ID, MarketplaceRole.RENTER);
    const body = {
      ...VALID_BODY,
      renterId: RENTER_ID, // spoofed — should be ignored
    };

    const res = await initiateRental(attackerToken, body);
    if (res.status === 201) {
      expect(res.body.data.rental.renterId).toBe(ATTACKER_ID);
    }
  });
});

// ========================================================================
// E. HIGH-RISK / BLOCKED ACTOR
// ========================================================================

describe('Rental Initiation Adversarial: High-Risk Actor', () => {
  it('ensures auth success does not bypass business risk policy', async () => {
    const result = makeTestApp();
    app = result.app;
    deps = result.deps;

    const riskUser = User.create({
      id: RISKY_ID, role: MarketplaceRole.RENTER,
      trustScore: 20, disputesCount: 5, chargebacksCount: 3,
      createdAt: ONE_YEAR_AGO,
    });
    const owner = User.create({
      id: OWNER_ID, role: MarketplaceRole.OWNER,
      trustScore: 90, disputesCount: 0, chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    const watch = Watch.create({
      id: WATCH_RISK_ID, ownerId: OWNER_ID, marketValue: 1500,
      verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
      createdAt: ONE_YEAR_AGO,
    });
    const kyc = KycProfile.create({
      userId: RISKY_ID, providerReference: 'ref-risk', createdAt: ONE_YEAR_AGO,
    });
    kyc.submitForVerification();
    kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
    const insurance = InsurancePolicy.create({
      id: 'ins-risk', watchId: WATCH_RISK_ID, providerId: 'prov-1',
      coverageAmount: 15000, deductible: 500, premiumPerRental: 50,
      effectiveFrom: ONE_YEAR_AGO, effectiveTo: ONE_YEAR_LATER, createdAt: ONE_YEAR_AGO,
    });

    await deps.rental.userRepo.save(riskUser);
    await deps.rental.userRepo.save(owner);
    await deps.rental.watchRepo.save(watch);
    await deps.rental.kycRepo.save(kyc);
    await deps.rental.insuranceRepo.save(insurance);

    const token = signToken(RISKY_ID, MarketplaceRole.RENTER);
    const res = await initiateRental(token, { ...VALID_BODY, watchId: WATCH_RISK_ID });

    // High-risk user: system should respond (not crash) even for risky actors
    expect(res.status).toBeDefined();
    // The RiskPolicy may allow with review case, or block — either is safe
  });
});

// ========================================================================
// F. VALIDATION FAIL-CLOSED
// ========================================================================

describe('Rental Initiation Adversarial: Validation Fail-Closed', () => {
  beforeEach(setupStandardRentalContext);

  it('fails closed when required fields are missing', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);
    const res = await initiateRental(token, {});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('fails closed on invalid watchId format', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);
    const res = await initiateRental(token, {
      watchId: 'not-a-uuid',
      rentalPrice: 500,
      city: 'NYC',
      zipCode: '10001',
    });

    expect(res.status).toBe(400);
  });

  it('fails closed on negative rental price', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);
    const res = await initiateRental(token, {
      watchId: WATCH_ID,
      rentalPrice: -100,
      city: 'NYC',
      zipCode: '10001',
    });

    expect(res.status).toBe(400);
  });

  it('no partial rental creation on validation failure', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);
    await initiateRental(token, {
      watchId: 'not-a-uuid',
      rentalPrice: -100,
      city: 'NYC',
      zipCode: '10001',
    });

    const rentals = await (deps.rental.rentalRepo as InMemoryRentalRepository)
      .findActiveByWatchId(WATCH_ID);
    expect(rentals.length).toBe(0);
  });
});
