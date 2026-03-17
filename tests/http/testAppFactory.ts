import { vi } from 'vitest';
import { createApp, AppDeps } from '../../src/http/app';
import { InitiateRentalService } from '../../src/application/services/InitiateRentalService';
import { MarketplacePaymentService } from '../../src/application/services/MarketplacePaymentService';
import { ExposureSnapshotService } from '../../src/application/services/ExposureSnapshotService';
import { InMemoryUserRepository } from '../../src/infrastructure/repositories/InMemoryUserRepository';
import { InMemoryWatchRepository } from '../../src/infrastructure/repositories/InMemoryWatchRepository';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryKycRepository } from '../../src/infrastructure/repositories/InMemoryKycRepository';
import { InMemoryInsuranceRepository } from '../../src/infrastructure/repositories/InMemoryInsuranceRepository';
import { InMemoryReviewRepository } from '../../src/infrastructure/repositories/InMemoryReviewRepository';
import { InMemoryClaimRepository } from '../../src/infrastructure/repositories/InMemoryClaimRepository';
import { InMemoryProcessedWebhookEventStore, WebhookController, WebhookVerifier } from '../../src/http/webhookController';
import { InMemoryIdempotencyStore } from '../../src/http/idempotency/IdempotencyStore';
import { InMemoryConnectedAccountStore } from '../../src/http/routes/ownerRoutes';
import { AuditLog } from '../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../src/infrastructure/audit/InMemoryAuditSink';
import { PaymentProvider } from '../../src/domain/interfaces/PaymentProvider';
import { testTokenService } from './testAuthHelper';
import { Express } from 'express';

export function makePaymentProvider(): PaymentProvider {
  return {
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_test' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/test' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test_123', paymentIntentId: 'pi_test_123' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test' }),
  };
}

export function makeTestApp(overrides?: {
  paymentProvider?: PaymentProvider;
  webhookVerifier?: WebhookVerifier;
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

  const exposureSnapshotService = new ExposureSnapshotService({
    rentalRepo,
    watchRepo,
    insuranceRepo,
  });
  const initiateRentalService = new InitiateRentalService(paymentProvider, auditLog);
  const marketplacePaymentService = new MarketplacePaymentService(paymentProvider, auditLog);

  const defaultVerifier: WebhookVerifier = () => { throw new Error('Stripe not configured'); };

  const webhookController = new WebhookController({
    paymentService: marketplacePaymentService,
    rentalRepo,
    auditLog,
    processedEvents,
    verifyWebhook: overrides?.webhookVerifier ?? defaultVerifier,
  });

  const deps: AppDeps = {
    health: { persistence: 'memory', stripe: 'stub' },
    rental: {
      initiateRentalService,
      exposureSnapshotService,
      userRepo,
      watchRepo,
      rentalRepo,
      kycRepo,
      insuranceRepo,
      claimRepo,
      reviewRepo,
      exposureConfig: {
        capitalReserve: 500_000,
        maxExposureToCapitalRatio: 3.0,
        maxSingleWatchUncoveredExposure: 50_000,
        maxActiveRentals: 100,
      },
      idempotencyStore,
    },
    owner: {
      paymentProvider,
      userRepo,
      connectedAccountStore,
    },
    webhookController,
    tokenService: testTokenService,
  };

  return { app: createApp(deps), deps };
}
