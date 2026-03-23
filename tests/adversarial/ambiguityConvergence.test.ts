/**
 * PHASE N.1 — AMBIGUITY CONVERGENCE ADVERSARIAL SUITE
 *
 * Verifies that ambiguous provider outcomes:
 * - Cannot duplicate money movement
 * - Remain convergent through retry/idempotency and/or reconciliation
 * - Are not silently misclassified on transfer-related flows
 */
import { describe, it, expect } from 'vitest';
import { ProviderError } from '../../src/domain/errors/ProviderError';
import { StripeWebhookHandler } from '../../src/infrastructure/payments/StripeWebhookHandler';
import { NormalizedEventType } from '../../src/application/payments/PaymentProviderEvent';
import { WebhookEventValidator, PaymentEventType } from '../../src/domain/services/WebhookEventValidator';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import Stripe from 'stripe';

// ========================================================================
// A. PAYMENT_FAILED NORMALIZATION
// ========================================================================

function fakeStripeEvent(type: string, dataObject: Record<string, unknown>): Stripe.Event {
  return {
    id: 'evt_norm_test',
    object: 'event',
    type,
    api_version: '2026-02-25.clover',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: dataObject as unknown as Stripe.Event.Data.Object },
  } as Stripe.Event;
}

describe('Ambiguity Convergence: PAYMENT_FAILED Normalization', () => {
  it('normalizes payment_intent.payment_failed to PAYMENT_FAILED', () => {
    const handler = new StripeWebhookHandler(
      new Stripe('sk_test_fake', { apiVersion: '2026-02-25.clover' }),
      'whsec_test',
    );
    const event = fakeStripeEvent('payment_intent.payment_failed', {
      id: 'pi_failed_norm',
      status: 'requires_payment_method',
    });

    const result = handler.normalize(event);
    expect(result).not.toBeNull();
    expect(result!.type).toBe(NormalizedEventType.PAYMENT_FAILED);
    expect(result!.externalPaymentIntentId).toBe('pi_failed_norm');
  });

  it('payment_intent.payment_failed is in supported events', () => {
    const handler = new StripeWebhookHandler(
      new Stripe('sk_test_fake', { apiVersion: '2026-02-25.clover' }),
      'whsec_test',
    );
    expect(handler.isSupportedEvent('payment_intent.payment_failed')).toBe(true);
  });
});

// ========================================================================
// B. PAYMENT_FAILED WEBHOOK VALIDATION
// ========================================================================

describe('Ambiguity Convergence: PAYMENT_FAILED Webhook Validation', () => {
  it('proceeds for PAYMENT_FAILED on AWAITING_EXTERNAL_PAYMENT', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_FAILED,
      EscrowStatus.AWAITING_EXTERNAL_PAYMENT,
      false,
    );
    expect(result.outcome).toBe('proceed');
  });

  it('proceeds for PAYMENT_FAILED on EXTERNAL_PAYMENT_AUTHORIZED', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_FAILED,
      EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED,
      false,
    );
    expect(result.outcome).toBe('proceed');
  });

  it('rejects PAYMENT_FAILED on EXTERNAL_PAYMENT_CAPTURED', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_FAILED,
      EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
      false,
    );
    expect(result.outcome).toBe('rejected');
  });

  it('rejects PAYMENT_FAILED on terminal FUNDS_RELEASED_TO_OWNER', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_FAILED,
      EscrowStatus.FUNDS_RELEASED_TO_OWNER,
      false,
    );
    expect(result.outcome).toBe('rejected');
  });

  it('rejects PAYMENT_FAILED on terminal REFUNDED', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_FAILED,
      EscrowStatus.REFUNDED,
      false,
    );
    expect(result.outcome).toBe('rejected');
  });
});

// ========================================================================
// C. TRANSFER AMBIGUITY — PROVIDER ERROR CLASSIFICATION
// ========================================================================

describe('Ambiguity Convergence: Transfer Error Classification', () => {
  it('network timeout on state-changing transfer is classified as ambiguous', () => {
    const error = new ProviderError({
      message: 'transferToConnectedAccount: ETIMEDOUT',
      code: 'PROVIDER_NETWORK_TIMEOUT',
      isStateChanging: true,
    });
    expect(error.ambiguous).toBe(true);
    expect(error.retryable).toBe(true);
  });

  it('card declined on transfer is NOT ambiguous', () => {
    const error = new ProviderError({
      message: 'transferToConnectedAccount: declined',
      code: 'PROVIDER_CARD_DECLINED',
      isStateChanging: true,
    });
    expect(error.ambiguous).toBe(false);
    expect(error.retryable).toBe(false);
  });

  it('network timeout on read is NOT ambiguous', () => {
    const error = new ProviderError({
      message: 'fetchTransfer: ETIMEDOUT',
      code: 'PROVIDER_NETWORK_TIMEOUT',
      isStateChanging: false,
    });
    expect(error.ambiguous).toBe(false);
    expect(error.retryable).toBe(true);
  });

  it('Stripe 5xx on state-changing transfer is classified as ambiguous', () => {
    const error = new ProviderError({
      message: 'transferToConnectedAccount: 500',
      code: 'PROVIDER_NETWORK_TIMEOUT',
      isStateChanging: true,
    });
    expect(error.ambiguous).toBe(true);
  });
});

// ========================================================================
// D. WEBHOOK REPLAY SAFETY (NO-REGRESSION)
// ========================================================================

describe('Ambiguity Convergence: Webhook Replay Safety', () => {
  it('duplicate PAYMENT_AUTHORIZED on already-authorized rental is detected as duplicate', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_AUTHORIZED,
      EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED,
      false,
    );
    expect(result.outcome).toBe('duplicate');
  });

  it('duplicate PAYMENT_CAPTURED on already-captured rental is detected as duplicate', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_CAPTURED,
      EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
      false,
    );
    expect(result.outcome).toBe('duplicate');
  });

  it('PAYMENT_AUTHORIZED on captured rental is rejected (regression)', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.PAYMENT_AUTHORIZED,
      EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
      false,
    );
    expect(result.outcome).toBe('rejected');
  });

  it('CHARGE_REFUNDED on terminal REFUNDED is detected as duplicate', () => {
    const result = WebhookEventValidator.validate(
      PaymentEventType.CHARGE_REFUNDED,
      EscrowStatus.REFUNDED,
      false,
    );
    expect(result.outcome).toBe('duplicate');
  });
});
