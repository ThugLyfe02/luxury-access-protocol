import { describe, it, expect, vi } from 'vitest';
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
import { WebhookController, InMemoryProcessedWebhookEventStore } from '../../src/http/webhookController';
import { InMemoryIdempotencyStore } from '../../src/http/idempotency/IdempotencyStore';
import { InMemoryConnectedAccountStore } from '../../src/http/routes/ownerRoutes';
import { AuditLog } from '../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../src/infrastructure/audit/InMemoryAuditSink';
import { PaymentProvider } from '../../src/domain/interfaces/PaymentProvider';
import { User } from '../../src/domain/entities/User';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';
import { Express } from 'express';

const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const ONE_YEAR_AGO = new Date('2025-03-17T12:00:00Z');

function makePaymentProvider(): PaymentProvider {
  return {
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_owner_123' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/onboard' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test', paymentIntentId: 'pi_test' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test' }),
  };
}

function makeOwnerApp(): { app: Express; deps: AppDeps } {
  const pp = makePaymentProvider();
  const auditLog = new AuditLog(new InMemoryAuditSink());
  const userRepo = new InMemoryUserRepository();
  const rentalRepo = new InMemoryRentalRepository();

  const deps: AppDeps = {
    health: { persistence: 'memory', stripe: 'stub' },
    rental: {
      initiateRentalService: new InitiateRentalService(pp, auditLog),
      userRepo,
      watchRepo: new InMemoryWatchRepository(),
      rentalRepo,
      kycRepo: new InMemoryKycRepository(),
      insuranceRepo: new InMemoryInsuranceRepository(),
      claimRepo: new InMemoryClaimRepository(),
      reviewRepo: new InMemoryReviewRepository(),
      exposureConfig: {
        capitalReserve: 500_000,
        maxExposureToCapitalRatio: 3.0,
        maxSingleWatchUncoveredExposure: 50_000,
        maxActiveRentals: 100,
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
    },
    owner: {
      paymentProvider: pp,
      userRepo,
      connectedAccountStore: new InMemoryConnectedAccountStore(),
    },
    webhookController: new WebhookController({
      paymentService: new MarketplacePaymentService(pp, auditLog),
      rentalRepo,
      auditLog,
      processedEvents: new InMemoryProcessedWebhookEventStore(),
      verifyWebhook: () => { throw new Error('not configured'); },
    }),
  };

  return { app: createApp(deps), deps };
}

async function seedOwner(deps: AppDeps): Promise<void> {
  const owner = User.create({
    id: OWNER_ID,
    role: MarketplaceRole.OWNER,
    trustScore: 90,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.owner.userRepo.save(owner);
}

describe('POST /owners/:ownerId/connected-account', () => {
  it('creates connected account for valid owner', async () => {
    const { app, deps } = makeOwnerApp();
    await seedOwner(deps);

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.connectedAccountId).toBe('acct_owner_123');
    expect(res.body.data.alreadyExists).toBe(false);
  });

  it('returns existing account idempotently', async () => {
    const { app, deps } = makeOwnerApp();
    await seedOwner(deps);

    await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'owner@test.com', country: 'US' });

    const res2 = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res2.status).toBe(200);
    expect(res2.body.data.alreadyExists).toBe(true);
  });

  it('rejects invalid ownerId', async () => {
    const { app } = makeOwnerApp();

    const res = await request(app)
      .post('/owners/not-a-uuid/connected-account')
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid email', async () => {
    const { app } = makeOwnerApp();

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'not-an-email', country: 'US' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent owner', async () => {
    const { app } = makeOwnerApp();

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /owners/:ownerId/onboarding-link', () => {
  it('returns onboarding link for valid account', async () => {
    const { app, deps } = makeOwnerApp();
    await seedOwner(deps);

    // First create the connected account
    await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'owner@test.com', country: 'US' });

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/onboarding-link`)
      .send({
        connectedAccountId: 'acct_owner_123',
        returnUrl: 'https://app.test.com/return',
        refreshUrl: 'https://app.test.com/refresh',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.url).toBe('https://connect.stripe.com/onboard');
  });

  it('rejects mismatched connected account', async () => {
    const { app, deps } = makeOwnerApp();
    await seedOwner(deps);

    await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'owner@test.com', country: 'US' });

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/onboarding-link`)
      .send({
        connectedAccountId: 'acct_wrong',
        returnUrl: 'https://app.test.com/return',
        refreshUrl: 'https://app.test.com/refresh',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONNECTED_ACCOUNT_MISSING');
  });
});
