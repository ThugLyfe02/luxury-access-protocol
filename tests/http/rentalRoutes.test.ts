import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp, AppDeps } from '../../src/http/app';
import { InitiateRentalService } from '../../src/application/services/InitiateRentalService';
import { MarketplacePaymentService } from '../../src/application/services/MarketplacePaymentService';
import { InMemoryUserRepository } from '../../src/infrastructure/repositories/InMemoryUserRepository';
import { InMemoryWatchRepository } from '../../src/infrastructure/repositories/InMemoryWatchRepository';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryKycRepository } from '../../src/infrastructure/repositories/InMemoryKycRepository';
import { InMemoryInsuranceRepository } from '../../src/infrastructure/repositories/InMemoryInsuranceRepository';
import { InMemoryReviewRepository } from '../../src/infrastructure/repositories/InMemoryReviewRepository';
import { InMemoryClaimRepository } from '../../src/infrastructure/repositories/InMemoryClaimRepository';
import { InMemoryProcessedWebhookEventStore, WebhookController } from '../../src/http/webhookController';
import { InMemoryIdempotencyStore } from '../../src/http/idempotency/IdempotencyStore';
import { InMemoryConnectedAccountStore } from '../../src/http/routes/ownerRoutes';
import { AuditLog } from '../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../src/infrastructure/audit/InMemoryAuditSink';
import { PaymentProvider } from '../../src/domain/interfaces/PaymentProvider';
import { User } from '../../src/domain/entities/User';
import { Watch } from '../../src/domain/entities/Watch';
import { KycProfile } from '../../src/domain/entities/KycProfile';
import { InsurancePolicy } from '../../src/domain/entities/InsurancePolicy';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';
import { VerificationStatus } from '../../src/domain/enums/VerificationStatus';
import { ExposureConfig } from '../../src/domain/services/PlatformExposureEngine';
import { Express } from 'express';

const NOW = new Date('2026-03-17T12:00:00Z');
const ONE_YEAR_AGO = new Date('2025-03-17T12:00:00Z');
const ONE_YEAR_LATER = new Date('2027-03-17T12:00:00Z');

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

const exposureConfig: ExposureConfig = {
  capitalReserve: 500_000,
  maxExposureToCapitalRatio: 3.0,
  maxSingleWatchUncoveredExposure: 50_000,
  maxActiveRentals: 100,
};

const RENTER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const WATCH_ID = '33333333-3333-3333-3333-333333333333';

function makeApp(overrides?: {
  paymentProvider?: PaymentProvider;
}): { app: Express; deps: AppDeps } {
  const paymentProvider = overrides?.paymentProvider ?? makePaymentProvider();
  const auditLog = new AuditLog(new InMemoryAuditSink());
  const userRepo = new InMemoryUserRepository();
  const watchRepo = new InMemoryWatchRepository();
  const rentalRepo = new InMemoryRentalRepository();
  const kycRepo = new InMemoryKycRepository();
  const insuranceRepo = new InMemoryInsuranceRepository();
  const reviewRepo = new InMemoryReviewRepository();
  const claimRepo = new InMemoryClaimRepository();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const connectedAccountStore = new InMemoryConnectedAccountStore();
  const processedEvents = new InMemoryProcessedWebhookEventStore();

  const initiateRentalService = new InitiateRentalService(paymentProvider, auditLog);
  const marketplacePaymentService = new MarketplacePaymentService(paymentProvider, auditLog);

  const webhookController = new WebhookController({
    paymentService: marketplacePaymentService,
    rentalRepo,
    auditLog,
    processedEvents,
    verifyWebhook: () => { throw new Error('Stripe not configured'); },
  });

  const deps: AppDeps = {
    health: { persistence: 'memory', stripe: 'stub' },
    rental: {
      initiateRentalService,
      userRepo,
      watchRepo,
      rentalRepo,
      kycRepo,
      insuranceRepo,
      claimRepo,
      reviewRepo,
      exposureConfig,
      idempotencyStore,
    },
    owner: {
      paymentProvider,
      userRepo,
      connectedAccountStore,
    },
    webhookController,
  };

  return { app: createApp(deps), deps };
}

async function seedStandardData(deps: AppDeps): Promise<void> {
  const renter = User.create({
    id: RENTER_ID,
    role: MarketplaceRole.RENTER,
    trustScore: 85,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.userRepo.save(renter);

  const owner = User.create({
    id: OWNER_ID,
    role: MarketplaceRole.OWNER,
    trustScore: 90,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.userRepo.save(owner);

  const watch = Watch.create({
    id: WATCH_ID,
    ownerId: OWNER_ID,
    marketValue: 1500,
    verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.watchRepo.save(watch);

  const kyc = KycProfile.create({
    userId: RENTER_ID,
    providerReference: 'kyc_ref_1',
    createdAt: ONE_YEAR_AGO,
  });
  kyc.submitForVerification();
  kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
  await deps.rental.kycRepo.save(kyc);

  const insurance = InsurancePolicy.create({
    id: 'ins-1',
    watchId: WATCH_ID,
    providerId: 'ins-provider-1',
    coverageAmount: 15000,
    deductible: 500,
    premiumPerRental: 50,
    effectiveFrom: ONE_YEAR_AGO,
    effectiveTo: ONE_YEAR_LATER,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.insuranceRepo.save(insurance);
}

describe('POST /rentals/initiate', () => {
  it('succeeds with valid request', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 500,
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rental.renterId).toBe(RENTER_ID);
    expect(res.body.data.rental.watchId).toBe(WATCH_ID);
    expect(res.body.data.rental.escrowStatus).toBe('AWAITING_EXTERNAL_PAYMENT');
    expect(res.body.requestId).toBeDefined();
  });

  it('rejects invalid city', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 500,
        city: 'LA',
        zipCode: '10001',
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CITY_NOT_ACTIVE');
  });

  it('rejects invalid ZIP code format', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 200,
        city: 'NYC',
        zipCode: 'ABCDE',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects self-rental (renter is watch owner)', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    // Create watch owned by the renter
    const selfWatch = Watch.create({
      id: '44444444-4444-4444-4444-444444444444',
      ownerId: RENTER_ID,
      marketValue: 1500,
      verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.watchRepo.save(selfWatch);

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: '44444444-4444-4444-4444-444444444444',
        rentalPrice: 500,
        city: 'NYC',
        zipCode: '10001',
      });

    // AuthorizationGuard.rejectSelfOwned throws UNAUTHORIZED
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects high-risk user', async () => {
    const { app, deps } = makeApp();

    // Seed high-risk renter
    const renter = User.create({
      id: RENTER_ID,
      role: MarketplaceRole.RENTER,
      trustScore: 15,
      disputesCount: 4,
      chargebacksCount: 3,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(renter);

    const owner = User.create({
      id: OWNER_ID,
      role: MarketplaceRole.OWNER,
      trustScore: 90,
      disputesCount: 0,
      chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(owner);

    const watch = Watch.create({
      id: WATCH_ID,
      ownerId: OWNER_ID,
      marketValue: 1500,
      verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.watchRepo.save(watch);

    const kyc = KycProfile.create({
      userId: RENTER_ID,
      providerReference: 'kyc_ref_1',
      createdAt: ONE_YEAR_AGO,
    });
    kyc.submitForVerification();
    kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
    await deps.rental.kycRepo.save(kyc);

    const insurance = InsurancePolicy.create({
      id: 'ins-1',
      watchId: WATCH_ID,
      providerId: 'ins-provider-1',
      coverageAmount: 15000,
      deductible: 500,
      premiumPerRental: 50,
      effectiveFrom: ONE_YEAR_AGO,
      effectiveTo: ONE_YEAR_LATER,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.insuranceRepo.save(insurance);

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 500,
        city: 'NYC',
        zipCode: '10001',
      });

    // RiskPolicy.ensureCanInitiateRental throws HIGH_RISK_TRANSACTION for high-risk users
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HIGH_RISK_TRANSACTION');
  });

  it('rejects unverified high-value watch', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    const unverified = Watch.create({
      id: '55555555-5555-5555-5555-555555555555',
      ownerId: OWNER_ID,
      marketValue: 8000,
      verificationStatus: VerificationStatus.UNVERIFIED,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.watchRepo.save(unverified);

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: '55555555-5555-5555-5555-555555555555',
        rentalPrice: 400,
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WATCH_NOT_VERIFIED');
  });

  it('rejects negative economics', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 1, // too low for $1500 watch
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ECONOMICS_NEGATIVE');
  });

  it('returns cached response for duplicate idempotency key with same payload', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    const payload = {
      renterId: RENTER_ID,
      watchId: WATCH_ID,
      rentalPrice: 500,
      city: 'NYC',
      zipCode: '10001',
    };

    const res1 = await request(app)
      .post('/rentals/initiate')
      .set('Idempotency-Key', 'idem-key-1')
      .send(payload);

    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post('/rentals/initiate')
      .set('Idempotency-Key', 'idem-key-1')
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.data.rental.id).toBe(res1.body.data.rental.id);
  });

  it('rejects idempotency key reuse with different payload', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    await request(app)
      .post('/rentals/initiate')
      .set('Idempotency-Key', 'idem-key-2')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 500,
        city: 'NYC',
        zipCode: '10001',
      });

    const res2 = await request(app)
      .post('/rentals/initiate')
      .set('Idempotency-Key', 'idem-key-2')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 600, // different price
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects missing required fields', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .send({ renterId: RENTER_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects non-UUID renterId', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: 'not-a-uuid',
        watchId: WATCH_ID,
        rentalPrice: 200,
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details.some((e: { field: string }) => e.field === 'renterId')).toBe(true);
  });

  it('rejects NaN / negative rental price', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: -100,
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details.some((e: { field: string }) => e.field === 'rentalPrice')).toBe(true);
  });

  it('returns 404 for nonexistent renter', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 200,
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('concurrent same-watch initiation does not double-book', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    const payload = {
      renterId: RENTER_ID,
      watchId: WATCH_ID,
      rentalPrice: 500,
      city: 'NYC',
      zipCode: '10001',
    };

    // First request succeeds
    const res1 = await request(app).post('/rentals/initiate').send(payload);
    expect(res1.status).toBe(201);

    // Second request with same watch should fail (watch already reserved)
    const res2 = await request(app).post('/rentals/initiate').send(payload);
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('WATCH_ALREADY_RESERVED');
  });
});

describe('GET /rentals/:id', () => {
  it('returns rental by ID', async () => {
    const { app, deps } = makeApp();
    await seedStandardData(deps);

    // Create a rental first
    const createRes = await request(app)
      .post('/rentals/initiate')
      .send({
        renterId: RENTER_ID,
        watchId: WATCH_ID,
        rentalPrice: 500,
        city: 'NYC',
        zipCode: '10001',
      });

    const rentalId = createRes.body.data.rental.id;

    const res = await request(app).get(`/rentals/${rentalId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rental.id).toBe(rentalId);
    expect(res.body.data.rental.createdAt).toBeDefined();
  });

  it('returns 404 for nonexistent rental', async () => {
    const { app } = makeApp();

    const res = await request(app).get(`/rentals/${RENTER_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects invalid UUID param', async () => {
    const { app } = makeApp();

    const res = await request(app).get('/rentals/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
