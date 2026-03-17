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
import {
  WebhookController,
  InMemoryProcessedWebhookEventStore,
  WebhookVerifier,
} from '../../src/http/webhookController';
import { InMemoryIdempotencyStore } from '../../src/http/idempotency/IdempotencyStore';
import { InMemoryConnectedAccountStore } from '../../src/http/routes/ownerRoutes';
import { AuditLog } from '../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../src/infrastructure/audit/InMemoryAuditSink';
import { PaymentProvider } from '../../src/domain/interfaces/PaymentProvider';
import { DomainError } from '../../src/domain/errors/DomainError';
import { NormalizedEventType, PaymentProviderEvent } from '../../src/application/payments/PaymentProviderEvent';
import { Rental } from '../../src/domain/entities/Rental';
import { Express } from 'express';

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

function makeWebhookApp(opts: {
  verifier?: WebhookVerifier;
} = {}): { app: Express; rentalRepo: InMemoryRentalRepository; processedEvents: InMemoryProcessedWebhookEventStore } {
  const paymentProvider = makePaymentProvider();
  const auditLog = new AuditLog(new InMemoryAuditSink());
  const rentalRepo = new InMemoryRentalRepository();
  const processedEvents = new InMemoryProcessedWebhookEventStore();

  const verifier: WebhookVerifier = opts.verifier ?? (() => {
    throw new DomainError('Invalid signature', 'WEBHOOK_SIGNATURE_INVALID');
  });

  const webhookController = new WebhookController({
    paymentService: new MarketplacePaymentService(paymentProvider, auditLog),
    rentalRepo,
    auditLog,
    processedEvents,
    verifyWebhook: verifier,
  });

  const deps: AppDeps = {
    health: { persistence: 'memory', stripe: 'stub' },
    rental: {
      initiateRentalService: new InitiateRentalService(paymentProvider, auditLog),
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
      paymentProvider,
      userRepo: new InMemoryUserRepository(),
      connectedAccountStore: new InMemoryConnectedAccountStore(),
    },
    webhookController,
  };

  return { app: createApp(deps), rentalRepo, processedEvents };
}

describe('POST /webhooks/stripe', () => {
  it('rejects request with invalid signature', async () => {
    const { app } = makeWebhookApp();

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'invalid_sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects request without stripe-signature header', async () => {
    const { app } = makeWebhookApp();

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(400);
  });

  it('returns 200 for unsupported but valid event', async () => {
    const { app } = makeWebhookApp({
      verifier: () => null, // unsupported event
    });

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid_sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
    expect(res.body.reason).toBe('unsupported_event_type');
  });

  it('processes supported event and returns 200', async () => {
    const { app, rentalRepo } = makeWebhookApp({
      verifier: () => ({
        stripeEventId: 'evt_123',
        event: {
          externalEventId: 'evt_123',
          type: NormalizedEventType.PAYMENT_AUTHORIZED,
          externalPaymentIntentId: 'pi_real_123',
          externalCheckoutSessionId: null,
          connectedAccountId: null,
          refundAmountCents: null,
          disputeWonByPlatform: null,
          rawReferenceId: 'pi_real_123',
          occurredAt: new Date(),
        } satisfies PaymentProviderEvent,
      }),
    });

    // Seed a rental in AWAITING_EXTERNAL_PAYMENT state
    const rental = Rental.create({
      id: 'rental-1',
      renterId: 'renter-1',
      watchId: 'watch-1',
      rentalPrice: 200,
      createdAt: new Date(),
    });
    rental.startExternalPayment('pi_real_123');
    await rentalRepo.save(rental);

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid_sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(true);
  });

  it('handles duplicate event idempotently', async () => {
    const { app, rentalRepo, processedEvents } = makeWebhookApp({
      verifier: () => ({
        stripeEventId: 'evt_dup',
        event: {
          externalEventId: 'evt_dup',
          type: NormalizedEventType.PAYMENT_AUTHORIZED,
          externalPaymentIntentId: 'pi_dup',
          externalCheckoutSessionId: null,
          connectedAccountId: null,
          refundAmountCents: null,
          disputeWonByPlatform: null,
          rawReferenceId: 'pi_dup',
          occurredAt: new Date(),
        } satisfies PaymentProviderEvent,
      }),
    });

    // Pre-record as processed
    await processedEvents.add('evt_dup', 'rental-1', 'PAYMENT_AUTHORIZED');

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid_sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
    expect(res.body.reason).toBe('already_processed');
  });
});
