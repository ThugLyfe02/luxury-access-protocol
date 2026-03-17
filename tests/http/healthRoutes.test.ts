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
import { testTokenService } from './testAuthHelper';

function makePaymentProvider(): PaymentProvider {
  return {
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_test' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/test' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test', paymentIntentId: 'pi_test' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test' }),
  };
}

function buildApp(health: { persistence: 'postgres' | 'memory'; stripe: 'live' | 'stub' }) {
  const pp = makePaymentProvider();
  const auditLog = new AuditLog(new InMemoryAuditSink());
  const rentalRepo = new InMemoryRentalRepository();

  const deps: AppDeps = {
    health,
    rental: {
      initiateRentalService: new InitiateRentalService(pp, auditLog),
      userRepo: new InMemoryUserRepository(),
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
      userRepo: new InMemoryUserRepository(),
      connectedAccountStore: new InMemoryConnectedAccountStore(),
    },
    webhookController: new WebhookController({
      paymentService: new MarketplacePaymentService(pp, auditLog),
      rentalRepo,
      auditLog,
      processedEvents: new InMemoryProcessedWebhookEventStore(),
      verifyWebhook: () => { throw new Error('not configured'); },
    }),
    tokenService: testTokenService,
  };

  return createApp(deps);
}

describe('GET /health', () => {
  it('returns 200 with service status', async () => {
    const app = buildApp({ persistence: 'memory', stripe: 'stub' });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.persistence).toBe('memory');
    expect(res.body.data.stripe).toBe('stub');
  });

  it('includes request ID in response', async () => {
    const app = buildApp({ persistence: 'memory', stripe: 'stub' });

    const res = await request(app).get('/health');

    expect(res.body.requestId).toBeDefined();
    expect(typeof res.body.requestId).toBe('string');
  });

  it('propagates provided X-Request-Id', async () => {
    const app = buildApp({ persistence: 'memory', stripe: 'stub' });

    const res = await request(app)
      .get('/health')
      .set('X-Request-Id', 'custom-req-id');

    expect(res.headers['x-request-id']).toBe('custom-req-id');
    expect(res.body.requestId).toBe('custom-req-id');
  });
});

describe('GET /ready', () => {
  it('returns 503 when stripe is stub', async () => {
    const app = buildApp({ persistence: 'memory', stripe: 'stub' });

    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.data.ready).toBe(false);
    expect(res.body.data.checks.stripe).toBe(false);
  });

  it('returns 200 when all services are live', async () => {
    const app = buildApp({ persistence: 'postgres', stripe: 'live' });

    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
  });
});
