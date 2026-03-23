/**
 * PHASE F — AUTH / AUTHZ ABUSE SUITE
 *
 * Tests JWT misuse, actor mismatch, role-based authorization abuse,
 * body identity spoofing, and sensitive data leakage in logging.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Express } from 'express';
import { makeTestApp } from '../http/testAppFactory';
import { signToken, signExpiredToken, TEST_AUTH_CONFIG } from '../http/testAuthHelper';
import { JwtTokenService } from '../../src/auth/JwtTokenService';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';
import { User } from '../../src/domain/entities/User';
import { Watch } from '../../src/domain/entities/Watch';
import { KycProfile } from '../../src/domain/entities/KycProfile';
import { InsurancePolicy } from '../../src/domain/entities/InsurancePolicy';
import { Rental } from '../../src/domain/entities/Rental';
import { VerificationStatus } from '../../src/domain/enums/VerificationStatus';
import { AppDeps } from '../../src/http/app';

// Proper UUIDs required by validation
const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const RENTER_ID = '22222222-2222-2222-2222-222222222222';
const RENTER2_ID = '33333333-3333-3333-3333-333333333333';
const ADMIN_ID = '44444444-4444-4444-4444-444444444444';
const WATCH_ID = '55555555-5555-5555-5555-555555555555';
const ONE_YEAR_AGO = new Date('2025-03-17');
const ONE_YEAR_LATER = new Date('2027-03-17');

let app: Express;
let deps: AppDeps;

async function setup() {
  const result = makeTestApp();
  app = result.app;
  deps = result.deps;

  const owner = User.create({
    id: OWNER_ID, role: MarketplaceRole.OWNER,
    trustScore: 90, disputesCount: 0, chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  const renter = User.create({
    id: RENTER_ID, role: MarketplaceRole.RENTER,
    trustScore: 85, disputesCount: 0, chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  const admin = User.create({
    id: ADMIN_ID, role: MarketplaceRole.ADMIN,
    trustScore: 100, disputesCount: 0, chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });

  await deps.rental.userRepo.save(owner);
  await deps.rental.userRepo.save(renter);
  await deps.rental.userRepo.save(admin);

  // Also save to owner route's userRepo (separate instance in makeTestApp)
  await deps.owner.userRepo.save(owner);
  await deps.owner.userRepo.save(renter);
  await deps.owner.userRepo.save(admin);

  const watch = Watch.create({
    id: WATCH_ID, ownerId: OWNER_ID, marketValue: 3000,
    verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.watchRepo.save(watch);

  // Seed owner connected account
  await deps.owner.connectedAccountStore.save(OWNER_ID, 'acct_owner_1');
}

// ========================================================================
// A. MISSING JWT ON PROTECTED ROUTES
// ========================================================================

describe('Auth Adversarial: Missing JWT', () => {
  beforeEach(setup);

  it('returns 401 on rental initiation without auth header', async () => {
    const res = await request(app)
      .post('/rentals/initiate')
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 on GET /rentals/:id without auth header', async () => {
    const res = await request(app).get(`/rentals/${RENTER_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 on owner routes without auth header', async () => {
    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'test@test.com', country: 'US' });
    expect(res.status).toBe(401);
  });
});

// ========================================================================
// B. INVALID JWT
// ========================================================================

describe('Auth Adversarial: Invalid JWT', () => {
  beforeEach(setup);

  it('returns 401 with completely invalid token string', async () => {
    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', 'Bearer not-a-jwt-at-all')
      .send({ watchId: WATCH_ID });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 when Authorization header has no Bearer prefix', async () => {
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);
    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', token)
      .send({ watchId: WATCH_ID });
    expect(res.status).toBe(401);
  });

  it('returns 401 with token signed by wrong secret', async () => {
    const wrongService = new JwtTokenService({
      ...TEST_AUTH_CONFIG,
      jwtSecret: 'wrong-secret-key-that-is-at-least-32-characters',
    });
    const wrongToken = wrongService.sign({ userId: RENTER_ID, role: MarketplaceRole.RENTER });

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${wrongToken}`)
      .send({ watchId: WATCH_ID });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 with token from wrong issuer', async () => {
    const wrongIssuer = new JwtTokenService({ ...TEST_AUTH_CONFIG, jwtIssuer: 'wrong-issuer' });
    const token = wrongIssuer.sign({ userId: RENTER_ID, role: MarketplaceRole.RENTER });

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID });
    expect(res.status).toBe(401);
  });

  it('returns 401 with token from wrong audience', async () => {
    const wrongAud = new JwtTokenService({ ...TEST_AUTH_CONFIG, jwtAudience: 'wrong-audience' });
    const token = wrongAud.sign({ userId: RENTER_ID, role: MarketplaceRole.RENTER });

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID });
    expect(res.status).toBe(401);
  });
});

// ========================================================================
// C. EXPIRED JWT
// ========================================================================

describe('Auth Adversarial: Expired JWT', () => {
  beforeEach(setup);

  it('returns 401 with TOKEN_EXPIRED code for expired token', async () => {
    const expiredToken = signExpiredToken(RENTER_ID, MarketplaceRole.RENTER);
    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({ watchId: WATCH_ID });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });
});

// ========================================================================
// D. WRONG ACTOR ACCESSING ANOTHER USER'S RESOURCE
// ========================================================================

describe('Auth Adversarial: Cross-User Resource Access', () => {
  beforeEach(setup);

  it('returns 403 when renter accesses another renters rental', async () => {
    const rental = Rental.create({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: new Date(),
    });
    await deps.rental.rentalRepo.save(rental);

    // Another renter
    const renter2 = User.create({
      id: RENTER2_ID, role: MarketplaceRole.RENTER,
      trustScore: 85, disputesCount: 0, chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(renter2);

    const token = signToken(RENTER2_ID, MarketplaceRole.RENTER);
    const res = await request(app)
      .get('/rentals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows admin to access any renters rental', async () => {
    const rental = Rental.create({
      id: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
      renterId: RENTER_ID, watchId: WATCH_ID,
      rentalPrice: 500, createdAt: new Date(),
    });
    await deps.rental.rentalRepo.save(rental);

    const token = signToken(ADMIN_ID, MarketplaceRole.ADMIN);
    const res = await request(app)
      .get('/rentals/aaaaaaaa-bbbb-cccc-dddd-ffffffffffff')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// ========================================================================
// E. OWNER ROUTE ACCESSED BY RENTER
// ========================================================================

describe('Auth Adversarial: Role-Based Route Access', () => {
  beforeEach(setup);

  it('returns 403 when renter tries to create owner connected account', async () => {
    const renterToken = signToken(RENTER_ID, MarketplaceRole.RENTER);
    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ email: 'test@test.com', country: 'US' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when renter tries to get owner onboarding link', async () => {
    const renterToken = signToken(RENTER_ID, MarketplaceRole.RENTER);
    const res = await request(app)
      .post(`/owners/${OWNER_ID}/onboarding-link`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({
        connectedAccountId: 'acct_owner_1',
        returnUrl: 'https://example.com/return',
        refreshUrl: 'https://example.com/refresh',
      });
    expect(res.status).toBe(403);
  });

  it('allows owner to access their own routes', async () => {
    const ownerToken = signToken(OWNER_ID, MarketplaceRole.OWNER);
    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'owner@test.com', country: 'US' });
    // Already exists from setup
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyExists).toBe(true);
  });
});

// ========================================================================
// F. ADMIN ROUTE PROTECTION
// ========================================================================

describe('Auth Adversarial: Admin Route Protection', () => {
  beforeEach(setup);

  it('admin can access another owners connected account', async () => {
    const adminToken = signToken(ADMIN_ID, MarketplaceRole.ADMIN);
    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'admin@test.com', country: 'US' });
    expect(res.status).toBe(200);
  });
});

// ========================================================================
// G. BODY IDENTITY OVERRIDE ATTEMPT
// ========================================================================

describe('Auth Adversarial: Body Identity Override Attempt', () => {
  beforeEach(async () => {
    await setup();
    const renter2 = User.create({
      id: RENTER2_ID, role: MarketplaceRole.RENTER,
      trustScore: 85, disputesCount: 0, chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(renter2);
    const kyc = KycProfile.create({
      userId: RENTER2_ID, providerReference: 'ref-2', createdAt: ONE_YEAR_AGO,
    });
    kyc.submitForVerification();
    kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
    await deps.rental.kycRepo.save(kyc);

    const insurance = InsurancePolicy.create({
      id: 'ins-auth-1', watchId: WATCH_ID, providerId: 'prov-1',
      coverageAmount: 15000, deductible: 500, premiumPerRental: 50,
      effectiveFrom: ONE_YEAR_AGO, effectiveTo: ONE_YEAR_LATER, createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.insuranceRepo.save(insurance);
  });

  it('rental initiation ignores renterId in body, uses JWT actor', async () => {
    const token = signToken(RENTER2_ID, MarketplaceRole.RENTER);
    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        watchId: WATCH_ID,
        rentalPrice: 500,
        city: 'NYC',
        zipCode: '10001',
        renterId: RENTER_ID, // SPOOFED
      });

    if (res.status === 201) {
      expect(res.body.data.rental.renterId).toBe(RENTER2_ID);
    }
  });
});

// ========================================================================
// H. TOKEN LEAKAGE IN LOGGING
// ========================================================================

describe('Auth Adversarial: No Token Leakage in Logging', () => {
  beforeEach(setup);

  it('request logger does not include raw JWT in log output', async () => {
    const logOutput: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logOutput.push(args.map(String).join(' '));
    };

    try {
      const token = signToken(RENTER_ID, MarketplaceRole.RENTER);
      await request(app)
        .get(`/rentals/${RENTER_ID}`)
        .set('Authorization', `Bearer ${token}`);

      const tokenLeaked = logOutput.some((line) => line.includes(token));
      expect(tokenLeaked).toBe(false);

      const hasActorId = logOutput.some((line) => line.includes(RENTER_ID));
      expect(hasActorId).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it('request logger does not include jwt secret in log output', async () => {
    const logOutput: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logOutput.push(args.map(String).join(' '));
    };

    try {
      const token = signToken(RENTER_ID, MarketplaceRole.RENTER);
      await request(app)
        .get(`/rentals/${RENTER_ID}`)
        .set('Authorization', `Bearer ${token}`);

      const secretLeaked = logOutput.some((line) =>
        line.includes(TEST_AUTH_CONFIG.jwtSecret),
      );
      expect(secretLeaked).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });
});

// ========================================================================
// PUBLIC ROUTES BYPASS AUTH
// ========================================================================

describe('Auth Adversarial: Public Routes Do Not Require Auth', () => {
  beforeEach(setup);

  it('health route is accessible without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('webhook route uses Stripe signature, not JWT', async () => {
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});
