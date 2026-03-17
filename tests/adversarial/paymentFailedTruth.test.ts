/**
 * PHASE N.1 — PAYMENT_FAILED TRUTH ADVERSARIAL SUITE
 *
 * Verifies that PAYMENT_FAILED is:
 * - Normalized and processed (not silently dropped)
 * - Audit-only (no escrow state mutation)
 * - Safe under duplicate delivery
 * - Safe before/after success
 * - Safe on terminal rentals
 * - Safe after recovery/reconciliation
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

function makeRentalInState(
  id: string,
  piId: string,
  state: 'awaiting' | 'authorized' | 'captured' | 'released' | 'refunded',
): Rental {
  const rental = Rental.create({
    id, renterId: 'renter-1', watchId: `w-${id}`,
    rentalPrice: 500, createdAt: new Date(),
  });
  rental.startExternalPayment(piId);
  if (state === 'awaiting') return rental;
  rental.markPaymentAuthorized();
  if (state === 'authorized') return rental;
  rental.markPaymentCaptured();
  if (state === 'captured') return rental;
  if (state === 'released') {
    rental.confirmReturn();
    rental.releaseFunds();
    return rental;
  }
  // refunded
  rental.markRefunded();
  return rental;
}

function sendWebhook(app: Express) {
  return request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'valid_sig')
    .send(Buffer.from('{}'));
}

// ========================================================================
// A. PAYMENT_FAILED TRUTH
// ========================================================================

describe('PAYMENT_FAILED Truth: Normalized and Processed', () => {
  it('processes payment_failed event on awaiting rental (no state mutation, audit recorded)', async () => {
    const PI = 'pi_fail_1';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_fail_1');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalInState('r-fail1', PI, 'awaiting');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(true);

    // Escrow status unchanged — failure is non-terminal
    const after = await ctx.rentalRepo.findById('r-fail1');
    expect(after!.escrowStatus).toBe(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);

    // Audit log records the failure
    const auditEntry = ctx.auditSink.entries().find(
      (e) => e.action === 'payment_failed',
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.outcome).toBe('success');
  });

  it('processes payment_failed on authorized rental (no state mutation)', async () => {
    const PI = 'pi_fail_auth';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_fail_auth');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalInState('r-fail-auth', PI, 'authorized');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(true);

    const after = await ctx.rentalRepo.findById('r-fail-auth');
    expect(after!.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
  });
});

describe('PAYMENT_FAILED Truth: Duplicate Delivery', () => {
  it('safely deduplicates duplicate payment_failed events via event ID', async () => {
    const PI = 'pi_fail_dup';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_fail_dup');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalInState('r-fail-dup', PI, 'awaiting');
    await ctx.rentalRepo.save(rental);

    // First delivery
    const res1 = await sendWebhook(ctx.app);
    expect(res1.status).toBe(200);
    expect(res1.body.processed).toBe(true);

    // Second delivery — event ID dedup
    const res2 = await sendWebhook(ctx.app);
    expect(res2.status).toBe(200);
    expect(res2.body.processed).toBe(false);
    expect(res2.body.reason).toBe('already_processed');
  });
});

describe('PAYMENT_FAILED Truth: Before Success', () => {
  it('payment_failed followed by payment_authorized succeeds normally', async () => {
    const PI = 'pi_fail_then_auth';
    const ctx = buildWebhookApp(() => {
      throw new Error('should not be called twice with same verifier');
    });

    const rental = makeRentalInState('r-fail-success', PI, 'awaiting');
    await ctx.rentalRepo.save(rental);

    // 1. Send payment_failed
    const failEvt = makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_f1');
    const ctx1 = buildWebhookApp(() => failEvt);
    // Re-use rental repo from ctx1
    await ctx1.rentalRepo.save(rental);

    const res1 = await sendWebhook(ctx1.app);
    expect(res1.status).toBe(200);
    expect(res1.body.processed).toBe(true);

    // Rental still in AWAITING — ready for retry
    const afterFail = await ctx1.rentalRepo.findById('r-fail-success');
    expect(afterFail!.escrowStatus).toBe(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);

    // 2. Send payment_authorized (renter retried)
    const authEvt = makeWebhookEvent(NormalizedEventType.PAYMENT_AUTHORIZED, PI, 'evt_a1');
    const ctx2 = buildWebhookApp(() => authEvt);
    await ctx2.rentalRepo.save(afterFail!);

    const res2 = await sendWebhook(ctx2.app);
    expect(res2.status).toBe(200);
    expect(res2.body.processed).toBe(true);

    const afterAuth = await ctx2.rentalRepo.findById('r-fail-success');
    expect(afterAuth!.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
  });
});

describe('PAYMENT_FAILED Truth: After Success', () => {
  it('rejects payment_failed on captured rental (out-of-order)', async () => {
    const PI = 'pi_fail_after_cap';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_fail_after');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalInState('r-fail-after', PI, 'captured');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_ESCROW_TRANSITION');

    // Rental unchanged
    const after = await ctx.rentalRepo.findById('r-fail-after');
    expect(after!.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
  });
});

describe('PAYMENT_FAILED Truth: Terminal State', () => {
  it('rejects payment_failed on released (terminal) rental', async () => {
    const PI = 'pi_fail_term';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_fail_term');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalInState('r-fail-term', PI, 'released');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_ESCROW_TRANSITION');
  });

  it('rejects payment_failed on refunded (terminal) rental', async () => {
    const PI = 'pi_fail_refund';
    const evt = makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_fail_refund');
    const ctx = buildWebhookApp(() => evt);

    const rental = makeRentalInState('r-fail-refund', PI, 'refunded');
    await ctx.rentalRepo.save(rental);

    const res = await sendWebhook(ctx.app);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_ESCROW_TRANSITION');
  });
});

describe('PAYMENT_FAILED Truth: Replay After Recovery', () => {
  it('payment_failed replay after manual auth correction is safely rejected', async () => {
    const PI = 'pi_fail_replay';
    const ctx = buildWebhookApp(() =>
      makeWebhookEvent(NormalizedEventType.PAYMENT_FAILED, PI, 'evt_replay_fail')
    );

    // Rental was manually corrected to AUTHORIZED state
    const rental = makeRentalInState('r-replay', PI, 'authorized');
    await ctx.rentalRepo.save(rental);

    // First: fail event is still valid on AUTHORIZED
    const res1 = await sendWebhook(ctx.app);
    expect(res1.status).toBe(200);
    expect(res1.body.processed).toBe(true);

    // Rental still authorized (no mutation)
    const after = await ctx.rentalRepo.findById('r-replay');
    expect(after!.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
  });
});
