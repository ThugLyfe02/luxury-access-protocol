/**
 * PHASE F — WEBHOOK ADVERSARIAL SUITE
 *
 * Tests hostile sequencing, duplicate replay, out-of-order delivery,
 * signature failures, and unknown event types against the webhook pipeline.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Express } from 'express';
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
import {
  WebhookController,
  InMemoryProcessedWebhookEventStore,
  WebhookVerifier,
} from '../../src/http/webhookController';
import { InMemoryIdempotencyStore } from '../../src/http/idempotency/IdempotencyStore';
import { InMemoryConnectedAccountStore } from '../../src/http/routes/ownerRoutes';
import { AuditLog } from '../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../src/infrastructure/audit/InMemoryAuditSink';
import { NormalizedEventType } from '../../src/application/payments/PaymentProviderEvent';
import { Rental } from '../../src/domain/entities/Rental';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { DomainError } from '../../src/domain/errors/DomainError';
import { testTokenService } from '../http/testAuthHelper';
import { makeStubPaymentProvider, makeWebhookEvent } from './helpers/adversarialFactories';

interface WebhookTestContext {
  app: Express;
  rentalRepo: InMemoryRentalRepository;
  processedEvents: InMemoryProcessedWebhookEventStore;
  auditSink: InMemoryAuditSink;
}

function buildWebhookApp(verifier: WebhookVerifier): WebhookTestContext {
  const paymentProvider = makeStubPaymentProvider();
  const auditSink = new InMemoryAuditSink();
  const auditLog = new AuditLog(auditSink);
  const rentalRepo = new InMemoryRentalRepository();
  const processedEvents = new InMemoryProcessedWebhookEventStore();
  const watchRepo = new InMemoryWatchRepository();
  const insuranceRepo = new InMemoryInsuranceRepository();

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
      exposureSnapshotService: new ExposureSnapshotService({ rentalRepo, watchRepo, insuranceRepo }),
      userRepo: new InMemoryUserRepository(),
      watchRepo,
      rentalRepo,
      kycRepo: new InMemoryKycRepository(),
      insuranceRepo,
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
    tokenService: testTokenService,
  };

  return { app: createApp(deps), rentalRepo, processedEvents, auditSink };
}

/**
 * Create a rental in a specific state with a given payment intent ID.
 * The PI must match what the webhook verifier returns.
 */
function makeRentalForWebhook(
  id: string,
  piId: string,
  targetState: 'awaiting' | 'authorized' | 'captured' | 'captured_return' | 'disputed',
): Rental {
  const rental = Rental.create({
    id, renterId: 'renter-1', watchId: `w-${id}`,
    rentalPrice: 500, createdAt: new Date(),
  });
  rental.startExternalPayment(piId);
  if (targetState === 'awaiting') return rental;
  rental.markPaymentAuthorized();
  if (targetState === 'authorized') return rental;
  rental.markPaymentCaptured();
  if (targetState === 'captured') return rental;
  if (targetState === 'captured_return') {
    rental.confirmReturn();
    return rental;
  }
  // disputed
  rental.markDisputed();
  return rental;
}

function sendWebhook(app: Express, sig = 'valid_sig') {
  return request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', sig)
    .send(Buffer.from('{}'));
}

// ========================================================================
// A. DUPLICATE EVENT REPLAY
// ========================================================================

describe('Webhook Adversarial: Duplicate Event Replay', () => {
  it('fails closed when duplicate webhook arrives after prior processing (event ID dedup)', async () => {
    const PI = 'pi_dup_test_1';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_AUTHORIZED, PI, 'evt_dup_1');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-dup1', PI, 'awaiting');
    await ctx.rentalRepo.save(rental);

    // First delivery — should succeed
    const res1 = await sendWebhook(ctx.app);
    expect(res1.status).toBe(200);
    expect(res1.body.processed).toBe(true);

    // Second delivery with same event ID — must be safely deduplicated
    const res2 = await sendWebhook(ctx.app);
    expect(res2.status).toBe(200);
    expect(res2.body.processed).toBe(false);
    expect(res2.body.reason).toBe('already_processed');
  });

  it('does not produce duplicate state transition on replayed event', async () => {
    const PI = 'pi_replay_test';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_AUTHORIZED, PI, 'evt_replay');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-replay', PI, 'awaiting');
    await ctx.rentalRepo.save(rental);

    await sendWebhook(ctx.app);
    const after1 = await ctx.rentalRepo.findById('r-replay');
    const version1 = after1!.version;

    await sendWebhook(ctx.app);
    const after2 = await ctx.rentalRepo.findById('r-replay');
    expect(after2!.version).toBe(version1);
  });

  it('records audit entry for duplicate event', async () => {
    const PI = 'pi_audit_dup';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_AUTHORIZED, PI, 'evt_audit_dup');
    const ctx = buildWebhookApp(() => evt);

    await ctx.processedEvents.add('evt_audit_dup', 'rental-1', 'PAYMENT_AUTHORIZED');

    await sendWebhook(ctx.app);

    const dedupEntry = ctx.auditSink.entries().find(
      (e) => e.action === 'webhook_event_id_dedup',
    );
    expect(dedupEntry).toBeDefined();
    expect(dedupEntry!.outcome).toBe('blocked');
    expect(dedupEntry!.errorCode).toBe('DUPLICATE_PAYMENT_EVENT');
  });
});

// ========================================================================
// B. OUT-OF-ORDER EVENT ARRIVAL
// ========================================================================

describe('Webhook Adversarial: Out-of-Order Event Delivery', () => {
  it('rejects PAYMENT_CAPTURED before PAYMENT_AUTHORIZED (out-of-order)', async () => {
    const PI = 'pi_ooo_1';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_CAPTURED, PI, 'evt_ooo_1');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-ooo1', PI, 'awaiting');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_ESCROW_TRANSITION');
  });

  it('rejects DISPUTE_CLOSED before DISPUTE_OPENED', async () => {
    const PI = 'pi_ooo_2';
    const evt = makeWebhookEvent(NormalizedEventType.DISPUTE_CLOSED, PI, 'evt_ooo_2');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-ooo2', PI, 'captured');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_ESCROW_TRANSITION');
  });

  it('rejects PAYMENT_REFUNDED after funds released (terminal state)', async () => {
    const PI = 'pi_ooo_3';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_REFUNDED, PI, 'evt_ooo_3');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-ooo3', PI, 'captured_return');
    rental.releaseFunds(); // transitions to FUNDS_RELEASED_TO_OWNER (terminal)
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    // Terminal state — refund should be rejected
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_ESCROW_TRANSITION');
  });

  it('handles DISPUTE_OPENED on captured rental and marks it disputed', async () => {
    const PI = 'pi_ooo_4';
    const evt = makeWebhookEvent(NormalizedEventType.DISPUTE_OPENED, PI, 'evt_ooo_4');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-ooo4', PI, 'captured_return');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(true);

    const updated = await ctx.rentalRepo.findById('r-ooo4');
    expect(updated!.escrowStatus).toBe(EscrowStatus.DISPUTED);
    expect(updated!.disputeOpen).toBe(true);
  });

  it('safely detects duplicate PAYMENT_AUTHORIZED when rental already authorized', async () => {
    const PI = 'pi_dup_auth';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_AUTHORIZED, PI, 'evt_dup_auth');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-dup-auth', PI, 'authorized');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
    expect(res.body.reason).toBe('duplicate_event');
  });

  it('rejects PAYMENT_AUTHORIZED on already captured rental (state regression)', async () => {
    const PI = 'pi_regress';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_AUTHORIZED, PI, 'evt_regress');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalForWebhook('r-regress', PI, 'captured');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_ESCROW_TRANSITION');
  });
});

// ========================================================================
// C. SIGNATURE FAILURES
// ========================================================================

describe('Webhook Adversarial: Signature Failures', () => {
  it('fails closed when stripe-signature header is missing', async () => {
    const ctx = buildWebhookApp(() => null);
    const res = await request(ctx.app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('fails closed when stripe-signature is invalid', async () => {
    const ctx = buildWebhookApp(() => {
      throw new DomainError('Invalid signature', 'WEBHOOK_SIGNATURE_INVALID');
    });
    const res = await sendWebhook(ctx.app, 'bad_signature');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('fails closed on malformed payload causing verifier to throw', async () => {
    const ctx = buildWebhookApp(() => {
      throw new DomainError('Malformed webhook payload', 'WEBHOOK_SIGNATURE_INVALID');
    });
    const res = await request(ctx.app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid_sig')
      .send(Buffer.from('not-json{{{'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});

// ========================================================================
// D. UNKNOWN EVENT TYPES
// ========================================================================

describe('Webhook Adversarial: Unknown Event Types', () => {
  it('does not mutate domain state for unknown event type', async () => {
    const ctx = buildWebhookApp(() => null);

    const rental = makeRentalForWebhook('r-unk', 'pi_unk', 'awaiting');
    await ctx.rentalRepo.save(rental);
    const versionBefore = (await ctx.rentalRepo.findById('r-unk'))!.version;

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
    expect(res.body.reason).toBe('unsupported_event_type');

    const after = await ctx.rentalRepo.findById('r-unk');
    expect(after!.version).toBe(versionBefore);
    expect(after!.escrowStatus).toBe(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);
  });

  it('returns safe acknowledgment for unknown event without error', async () => {
    const ctx = buildWebhookApp(() => null);
    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.processed).toBe(false);
  });
});
